import { randomUUID, randomInt } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { getDb, books, characters, voiceAssignments } from "@/lib/db";
import { getModel } from "@/lib/llm";
import { getVoiceCatalog, searchSharedVoices, type VoiceProfile } from "@/lib/elevenlabs/catalog";
import { NARRATOR_SETTINGS, DEFAULT_SETTINGS } from "@/lib/elevenlabs/tts";
import { AppError } from "@/lib/errors";

export const CAST_BATCH = 8;

// One model pick, captured from the assignVoice tool.
interface CastPick {
  voiceId: string;
  voiceName: string;
  stability: number;
  speed: number;
  rationale: string;
}

const normalizeName = (name: string) => name.trim().toLowerCase();

const VOICE_SEARCH_LIMIT = 14;

/** Filter the full catalog to a small, relevant shortlist for one search. */
function searchCatalog(
  voices: VoiceProfile[],
  q: { gender?: string; accent?: string; age?: string; query?: string; limit?: number }
): VoiceProfile[] {
  const gender = q.gender?.toLowerCase();
  const accent = q.accent?.toLowerCase().trim();
  const age = q.age?.toLowerCase();
  const query = q.query?.toLowerCase().trim();
  const ageBucket = (v: VoiceProfile) => voiceAgeBucket(v.age);
  const matches = voices.filter((v) => {
    if (gender && gender !== "neutral" && v.gender && v.gender.toLowerCase() !== gender) return false;
    if (accent && !(v.accent ?? "").toLowerCase().includes(accent)) return false;
    if (age && ageBucket(v) && ageBucket(v) !== age) return false;
    if (query) {
      const hay = `${v.name} ${v.descriptive ?? ""} ${v.description ?? ""} ${v.useCase ?? ""} ${v.accent ?? ""}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  return matches.slice(0, Math.min(q.limit ?? VOICE_SEARCH_LIMIT, 25));
}

export interface AlreadyCastEntry {
  name: string;
  voiceName: string | undefined;
  gender: string | null | undefined;
  age: string | null | undefined;
  accent: string | null | undefined;
}

export type AssignmentRow = typeof voiceAssignments.$inferInsert;

export interface CastingPrep {
  /** toCast character ids, narrator-first then by dialogue share. */
  orderedIds: string[];
  alreadyCast: AlreadyCastEntry[];
  hasVariants: boolean;
  shouldAdvanceStatus: boolean;
  voiceCount: number;
  characterCount: number;
}

/**
 * Everything up front: validations, catalog warm-up, and the batching order.
 * One giant call degrades badly on long cast lists (tail characters get
 * careless picks and filler rationales) — casting runs in small batches,
 * majors first, feeding each batch's picks forward as fixed context.
 */
export async function prepareCasting(bookId: string): Promise<CastingPrep> {
  const db = getDb();
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) throw new AppError("Book not found", "not_found", 404);

  const cast = await db.select().from(characters).where(eq(characters.bookId, bookId));
  if (cast.length === 0) {
    throw new AppError("Run character analysis first", "no_characters");
  }

  // "analyzed" for direct calls, "casting" when the route set it before
  // dispatch, "error" when retrying a failed cast
  const shouldAdvanceStatus = ["analyzed", "casting", "error"].includes(book.status);
  const voices = await getVoiceCatalog();
  if (voices.length === 0) {
    throw new AppError("No voices found in your ElevenLabs account", "no_voices");
  }

  const existing = await db
    .select()
    .from(voiceAssignments)
    .where(inArray(voiceAssignments.characterId, cast.map((c) => c.id)));
  const overriddenIds = new Set(existing.filter((a) => a.overridden).map((a) => a.characterId));
  const toCast = cast.filter((c) => !overriddenIds.has(c.id));

  const voiceById = new Map(voices.map((v) => [v.id, v]));
  // Manually-cast rows are excluded from toCast, so give the model their
  // picks as fixed context (an uncast variant should sound like its sibling).
  const alreadyCast: AlreadyCastEntry[] = cast
    .filter((c) => overriddenIds.has(c.id))
    .map((c) => {
      const a = existing.find((x) => x.characterId === c.id);
      const v = a ? voiceById.get(a.voiceId) : undefined;
      return {
        name: c.name,
        voiceName: a?.voiceName,
        gender: v?.gender,
        age: v?.age,
        accent: v?.accent,
      };
    });

  const ordered = [...toCast].sort(
    (a, b) => Number(b.isNarrator) - Number(a.isNarrator) || b.dialogueShare - a.dialogueShare
  );

  return {
    orderedIds: ordered.map((c) => c.id),
    alreadyCast,
    hasVariants: ordered.some((c) => c.variantGroup),
    shouldAdvanceStatus,
    voiceCount: voices.length,
    characterCount: toCast.length,
  };
}

/** One casting batch: LLM picks + hard-constraint validation + fallbacks. */
export async function castBatchLlm(
  bookId: string,
  batchIds: string[],
  alreadyCast: AlreadyCastEntry[],
  takenVoiceIds: string[],
  hasVariants: boolean
): Promise<{ rows: AssignmentRow[]; alreadyCast: AlreadyCastEntry[]; takenVoiceIds: string[] }> {
  const db = getDb();
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) throw new AppError("Book not found", "not_found", 404);
  const unordered = await db.select().from(characters).where(inArray(characters.id, batchIds));
  const byId = new Map(unordered.map((c) => [c.id, c]));
  const batch = batchIds.map((id) => byId.get(id)).filter((c) => c !== undefined);

  const voices = await getVoiceCatalog();
  // A model-reported voiceName is matched against the FULL catalog so a choice
  // still resolves even if the copied id is slightly off.
  const voicesByNormName = new Map<string, VoiceProfile>();
  for (const v of voices) {
    const key = normalizeName(v.name);
    if (!voicesByNormName.has(key)) voicesByNormName.set(key, v);
  }
  const accents = [...new Set(voices.map((v) => v.accent).filter(Boolean))].sort();
  // Every voice the model is shown (cache + live results) so its final pick
  // resolves even when it chose a live-only voice outside the cached slice.
  const seen = new Map(voices.map((v) => [v.id, v]));

  const batchInput = batch.map((c, i) => ({
    ref: i + 1,
    name: c.name,
    isNarrator: c.isNarrator,
    role: c.role,
    dialogueShare: c.dialogueShare,
    ...(c.variantGroup ? { variantGroup: c.variantGroup, lifeStage: c.variantLabel } : {}),
    ...c.profile,
  }));

  // The catalog is hundreds of voices — NEVER dumped into the prompt. The model
  // SEARCHES it per character (by accent/gender/age) to pull a tight, relevant
  // shortlist, then records each choice via assignVoice.
  const picks = new Map<number, CastPick>();
  await generateText({
    model: getModel("cast", book.modelPrefs),
    stopWhen: stepCountIs(batch.length * 3 + 6),
    tools: {
      searchVoices: tool({
        description:
          "Search the ElevenLabs voice catalog. Filter by gender, accent (a label like 'jamaican', 'irish', 'nigerian', 'southern'), age, and/or free text. Returns up to ~14 matching voices with exact voiceId + voiceName. You may call it several times, or in parallel for several characters.",
        inputSchema: z.object({
          gender: z.enum(["male", "female", "neutral"]).optional(),
          accent: z
            .string()
            .optional()
            .describe(`Available accents: ${accents.join(", ")}`),
          age: z.enum(["young", "middle", "old"]).optional(),
          query: z.string().optional().describe("Free-text match against name/description/style"),
          limit: z.number().int().min(1).max(25).optional(),
        }),
        execute: async (q) => {
          // Live shared library (all accents) + the cached slice (incl. the
          // account's own premades), deduped, then age-filtered client-side.
          let live: VoiceProfile[] = [];
          try {
            live = await searchSharedVoices({
              gender: q.gender,
              accent: q.accent,
              query: q.query,
              limit: q.limit,
            });
          } catch {
            // fall back to the cache alone if the live search fails
          }
          const merged = new Map<string, VoiceProfile>();
          for (const v of [...live, ...searchCatalog(voices, q)]) {
            if (v.id && !merged.has(v.id)) merged.set(v.id, v);
          }
          let found = [...merged.values()];
          if (q.age) found = found.filter((v) => !voiceAgeBucket(v.age) || voiceAgeBucket(v.age) === q.age);
          found = found.slice(0, Math.min(q.limit ?? VOICE_SEARCH_LIMIT, 25));
          for (const v of found) seen.set(v.id, v);
          return {
            count: found.length,
            voices: found.map((v) => ({
              voiceId: v.id,
              voiceName: v.name,
              gender: v.gender,
              age: v.age,
              accent: v.accent,
              style: v.descriptive,
              useCase: v.useCase,
              description: v.description?.slice(0, 160),
            })),
          };
        },
      }),
      assignVoice: tool({
        description:
          "Record the final voice for ONE character. Call exactly once per character ref, after searching. Copy voiceId + voiceName verbatim from a searchVoices result.",
        inputSchema: z.object({
          characterRef: z.number().int().describe("The character's ref number"),
          voiceId: z.string().describe("voiceId copied verbatim from a searchVoices result"),
          voiceName: z.string().describe("The matching voiceName"),
          stability: z
            .number()
            .min(0)
            .max(1)
            .describe("~0.35 for volatile/emotional characters, ~0.65 for steady voices and the narrator"),
          speed: z.number().min(0.85).max(1.1).describe("1.0 unless notably fast/slow spoken"),
          rationale: z
            .string()
            .describe("One specific line on why this voice fits — name the accent match"),
        }),
        execute: async (p) => {
          picks.set(p.characterRef, {
            voiceId: p.voiceId,
            voiceName: p.voiceName,
            stability: p.stability,
            speed: p.speed,
            rationale: p.rationale,
          });
          return "recorded";
        },
      }),
    },
    prompt:
      `Cast ElevenLabs voices for an audiobook of "${book.title}". Work character by character; you MUST call assignVoice exactly once for every character ref below.\n\n` +
      `For each character: read its profile, then call searchVoices with the fitting gender + accent, then assignVoice with the best result's exact voiceId + voiceName.\n\n` +
      `Rules:\n` +
      `- ACCENT MATTERS most. Map heritage/accentHint to a real accent label (Jamaican/Caribbean → "jamaican", Irish → "irish", Deep-South American → "southern", Russian émigré → "russian"). A confidently WRONG regional accent is a serious miss — never give a Jamaican character a British-RP or plain American voice, an Irish character an American one, etc. If no voice in the needed accent exists, search for a NEUTRAL/unlabeled one (or the closest region) — NEVER a voice carrying a different strong accent.\n` +
      `- Match gender strictly when known; match age closely (no young voice for an elderly character or vice versa).\n` +
      `- The narrator (isNarrator=true) gets a calm narration-suited voice (useCase like "narrative_story") and stability ~0.65.\n` +
      `- The narrator and every "major" character must get a DISTINCT voice, not one in ALREADY CAST. "minor" characters may share a voice with each other (never a major's or the narrator's) if needed.\n` +
      (hasVariants
        ? `- Characters sharing a variantGroup are ONE person at different life stages: give each a DIFFERENT voice but keep gender and accent consistent, plausibly the same person younger/older.\n`
        : "") +
      `\nCHARACTERS TO CAST NOW (each has a ref number):\n${JSON.stringify(batchInput)}\n\n` +
      (alreadyCast.length > 0
        ? `ALREADY CAST (fixed — don't reuse these voices for narrator/major characters; keep same-variantGroup siblings consistent):\n${JSON.stringify(alreadyCast)}\n`
        : ""),
  });

  const nextAlreadyCast = [...alreadyCast];
  const taken = new Set(takenVoiceIds);
  const rows: AssignmentRow[] = [];
  for (let i = 0; i < batch.length; i++) {
    const character = batch[i];
    const pick = picks.get(i + 1);
    // Resolve against everything the model saw (cache + live search results).
    let voice = pick ? seen.get(pick.voiceId) : undefined;
    // Self-correct: if the id didn't resolve or its name disagrees, trust the
    // reported voiceName (that's the model's real intent).
    if (pick && (!voice || normalizeName(voice.name) !== normalizeName(pick.voiceName))) {
      const byName =
        voicesByNormName.get(normalizeName(pick.voiceName)) ??
        [...seen.values()].find((v) => normalizeName(v.name) === normalizeName(pick.voiceName));
      if (byName) voice = byName;
    }
    const problem = !pick
      ? "not assigned"
      : !voice
        ? "unknown voice"
        : validatePick(character, voice, pick.rationale);
    let chosen: { voice: VoiceProfile; rationale: string; stability?: number; speed?: number };
    if (pick && voice && !problem) {
      chosen = {
        voice,
        rationale: pick.rationale,
        stability: pick.stability,
        speed: pick.speed,
      };
    } else {
      chosen = {
        voice: fallbackVoice(voices, character, taken),
        rationale: `Auto-matched by gender/age (model pick was ${problem})`,
      };
    }
    taken.add(chosen.voice.id);
    nextAlreadyCast.push({
      name: character.name,
      voiceName: chosen.voice.name,
      gender: chosen.voice.gender,
      age: chosen.voice.age,
      accent: chosen.voice.accent,
    });
    const base = character.isNarrator ? NARRATOR_SETTINGS : DEFAULT_SETTINGS;
    rows.push({
      id: randomUUID(),
      characterId: character.id,
      voiceId: chosen.voice.id,
      voiceName: chosen.voice.name,
      settings: {
        ...base,
        ...(chosen.stability !== undefined ? { stability: chosen.stability } : {}),
        ...(chosen.speed !== undefined ? { speed: chosen.speed } : {}),
      },
      seed: randomInt(0, 2 ** 31),
      rationale: chosen.rationale,
      overridden: false,
    });
  }

  return { rows, alreadyCast: nextAlreadyCast, takenVoiceIds: [...taken] };
}

/** Replace the auto-cast assignments; advance the book when the flow owns it. */
export async function persistAssignments(
  bookId: string,
  toCastIds: string[],
  rows: AssignmentRow[],
  shouldAdvanceStatus: boolean
): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    if (toCastIds.length > 0) {
      await tx.delete(voiceAssignments).where(inArray(voiceAssignments.characterId, toCastIds));
    }
    if (rows.length > 0) {
      await tx.insert(voiceAssignments).values(rows);
    }
    if (shouldAdvanceStatus) {
      await tx.update(books).set({ status: "cast" }).where(eq(books.id, bookId));
    }
  });
}

type CharacterRow = typeof characters.$inferSelect;

/** Hard constraints the model's pick must satisfy; returns the violation or null. */
function validatePick(
  character: CharacterRow,
  voice: VoiceProfile,
  rationale: string | undefined
): string | null {
  if (!rationale || rationale.trim().length < 12 || /\b(placeholder|todo|tbd|n\/a)\b/i.test(rationale)) {
    return "a filler rationale";
  }
  const charGender = character.profile.gender;
  const voiceGender = (voice.gender ?? "").toLowerCase();
  if (
    (charGender === "male" || charGender === "female") &&
    (voiceGender === "male" || voiceGender === "female") &&
    charGender !== voiceGender
  ) {
    return "a gender mismatch";
  }
  const charAge = characterAgeBucket(character.profile.ageRange);
  const voiceAge = voiceAgeBucket(voice.age);
  if (
    charAge &&
    voiceAge &&
    ((charAge === "old" && voiceAge === "young") || (charAge === "young" && voiceAge === "old"))
  ) {
    return "an age mismatch";
  }
  return null;
}

function characterAgeBucket(ageRange: string): "young" | "middle" | "old" | null {
  const t = ageRange.toLowerCase();
  if (/elder|senior|\bold|\b[6-9]0s?\b/.test(t)) return "old";
  if (/middle|\b[45]0s?\b/.test(t)) return "middle";
  if (/child|kid|teen|young|\b[12]0s?\b|\b1?[0-9]\b/.test(t)) return "young";
  return null;
}

function voiceAgeBucket(age: string | null): "young" | "middle" | "old" | null {
  const t = (age ?? "").toLowerCase();
  if (t.includes("young")) return "young";
  if (t.includes("old")) return "old";
  if (t.includes("middle")) return "middle";
  return null;
}

/**
 * Coarse accent family from free-form accent/heritage text, so the fallback
 * doesn't undo the model's accent work by handing (say) a Jamaican character
 * a British voice. Returns null for unlabeled/neutral text.
 */
function accentFamily(text: string | null | undefined): string | null {
  const t = (text ?? "").toLowerCase();
  if (!t) return null;
  if (/jamaic|caribbean|trinidad|bajan|west indian|creole/.test(t)) return "caribbean";
  if (/irish|ireland/.test(t)) return "irish";
  if (/scottish|scotland|glasw/.test(t)) return "scottish";
  if (/welsh|wales/.test(t)) return "welsh";
  if (/australia|aussie|new zealand|kiwi/.test(t)) return "australian";
  if (/british|england|\benglish\b|london|cockney|yorkshire|received pronunciation|\brp\b/.test(t))
    return "british";
  if (/american|\bu\.?s\.?\b|southern us|new york|texan|californ|midwest|canadian/.test(t))
    return "american";
  if (/india|indian/.test(t)) return "indian";
  if (/french|france/.test(t)) return "french";
  if (/german|germany/.test(t)) return "german";
  if (/russian|russia|slavic/.test(t)) return "russian";
  if (/spanish|spain|mexic|latin|hispanic/.test(t)) return "spanish";
  if (/italian|italy/.test(t)) return "italian";
  if (/african|nigeria|ghana|kenya|south africa/.test(t)) return "african";
  return null;
}

/** Deterministic pick honouring gender + age + accent compatibility, preferring unused voices. */
function fallbackVoice(
  voices: VoiceProfile[],
  character: CharacterRow,
  taken: Set<string>
): VoiceProfile {
  const gender = character.profile.gender;
  const charAge = characterAgeBucket(character.profile.ageRange);
  const charAccent =
    accentFamily(character.profile.accentHint) ?? accentFamily(character.profile.heritage);
  const genderOk = (v: VoiceProfile) =>
    !v.gender || gender === "unknown" || gender === "nonbinary" || v.gender === gender;
  const ageOk = (v: VoiceProfile) => {
    const voiceAge = voiceAgeBucket(v.age);
    if (!charAge || !voiceAge) return true;
    return !(
      (charAge === "old" && voiceAge === "young") ||
      (charAge === "young" && voiceAge === "old")
    );
  };
  // Exact accent match; otherwise a neutral/unlabeled voice — but never a
  // voice carrying a DIFFERENT strong accent (that's the whole point).
  const accentExact = (v: VoiceProfile) => charAccent !== null && accentFamily(v.accent) === charAccent;
  const accentOk = (v: VoiceProfile) => charAccent === null || accentFamily(v.accent) === null || accentExact(v);
  const pools = [
    voices.filter((v) => genderOk(v) && ageOk(v) && accentExact(v) && !taken.has(v.id)),
    voices.filter((v) => genderOk(v) && ageOk(v) && accentExact(v)),
    voices.filter((v) => genderOk(v) && ageOk(v) && accentOk(v) && !taken.has(v.id)),
    voices.filter((v) => genderOk(v) && ageOk(v) && accentOk(v)),
    voices.filter((v) => genderOk(v) && ageOk(v) && !taken.has(v.id)),
    voices.filter((v) => genderOk(v) && ageOk(v)),
    voices.filter((v) => genderOk(v) && !taken.has(v.id)),
    voices.filter(genderOk),
    voices,
  ];
  for (const pool of pools) {
    if (pool.length > 0) return pool[0];
  }
  return voices[0];
}
