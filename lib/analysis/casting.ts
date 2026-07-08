import { randomUUID, randomInt } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { getDb, books, characters, voiceAssignments } from "@/lib/db";
import { getModel } from "@/lib/llm";
import { getVoiceCatalog, type VoiceProfile } from "@/lib/elevenlabs/catalog";
import { NARRATOR_SETTINGS, DEFAULT_SETTINGS } from "@/lib/elevenlabs/tts";
import { AppError } from "@/lib/errors";

export const CAST_BATCH = 8;

const castingSchema = z.object({
  assignments: z.array(
    z.object({
      characterId: z.string(),
      voiceId: z.string(),
      rationale: z.string().describe("One line: why this voice fits this character"),
      stability: z
        .number()
        .min(0)
        .max(1)
        .describe("Lower (~0.35) for volatile/emotional characters, higher (~0.65) for steady ones and the narrator"),
      speed: z.number().min(0.85).max(1.1).describe("1.0 unless the character is notably fast/slow spoken"),
    })
  ),
});

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
  const voiceById = new Map(voices.map((v) => [v.id, v]));
  const voiceInput = voices.map((v) => ({
    voiceId: v.id,
    name: v.name,
    gender: v.gender,
    age: v.age,
    accent: v.accent,
    style: v.descriptive,
    useCase: v.useCase,
    description: v.description?.slice(0, 180),
  }));

  const batchInput = batch.map((c) => ({
    characterId: c.id,
    name: c.name,
    isNarrator: c.isNarrator,
    role: c.role,
    dialogueShare: c.dialogueShare,
    ...(c.variantGroup ? { variantGroup: c.variantGroup, lifeStage: c.variantLabel } : {}),
    ...c.profile,
  }));

  const { object } = await generateObject({
    model: getModel("cast", book.modelPrefs),
    schema: castingSchema,
    prompt:
      `Cast ElevenLabs voices for an audiobook of "${book.title}".\n\n` +
      `Rules:\n` +
      `- Assign exactly one voice to every characterId listed, each appearing exactly once, with a SPECIFIC one-line rationale tied to the character — never filler like "placeholder".\n` +
      `- Match gender strictly when known, and match age closely (an elderly character must not get a young voice and vice versa); approximate accent.\n` +
      `- The narrator entry (isNarrator=true) gets the best narration-suited voice (useCase like "narrative_story", calm/neutral) and stability around 0.65.\n` +
      `- The narrator and all "major" characters must each get a DISTINCT voice not in ALREADY CAST. "minor" characters may reuse each other's voices (never a major character's or the narrator's) when there aren't enough matching voices.\n` +
      `- Weigh heritage, accentHint, and voiceTexture heavily against each voice's accent, style, and description; heritage implies an accent only when the text supports it.\n` +
      (hasVariants
        ? `- Characters sharing a variantGroup are ONE person at different life stages: give each a DIFFERENT voice, but keep gender and accent consistent and pick voices that plausibly sound like the same person younger/older.\n`
        : "") +
      `\nCHARACTERS TO CAST NOW:\n${JSON.stringify(batchInput)}\n\n` +
      (alreadyCast.length > 0
        ? `ALREADY CAST (fixed — do not reassign these voices to narrator/major characters; keep new picks consistent, especially same-variantGroup siblings):\n${JSON.stringify(alreadyCast)}\n\n`
        : "") +
      `AVAILABLE VOICES:\n${JSON.stringify(voiceInput)}`,
  });

  const nextAlreadyCast = [...alreadyCast];
  const taken = new Set(takenVoiceIds);
  const rows: AssignmentRow[] = [];
  for (const character of batch) {
    const pick = object.assignments.find((a) => a.characterId === character.id);
    const voice = pick ? voiceById.get(pick.voiceId) : undefined;
    const problem = !pick
      ? "missing from response"
      : !voice
        ? "unknown voiceId"
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

/** Deterministic pick honouring gender + age compatibility, preferring unused voices. */
function fallbackVoice(
  voices: VoiceProfile[],
  character: CharacterRow,
  taken: Set<string>
): VoiceProfile {
  const gender = character.profile.gender;
  const charAge = characterAgeBucket(character.profile.ageRange);
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
  const pools = [
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
