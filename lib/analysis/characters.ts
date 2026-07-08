import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, books, chapters, characters, segments, voiceAssignments } from "@/lib/db";
import type { CharacterProfile } from "@/lib/db/schema";
import { chunkText, getModel } from "@/lib/llm";
import {
  assertNotCancelled,
  completeJob,
  failJob,
  noteJob,
  setJobTotal,
  tickJob,
} from "@/lib/jobs";
import { JobCancelledError } from "@/lib/errors";

const CHUNK_SIZE = 24_000;
const LLM_CONCURRENCY = 3;

const chunkSchema = z.object({
  characters: z.array(
    z.object({
      name: z.string().describe("Canonical character name"),
      aliases: z.array(z.string()).describe("Other names used for this character"),
      genderHint: z.enum(["male", "female", "nonbinary", "unknown"]),
      ageHint: z.string().describe("Apparent age, e.g. 'child', '20s', 'elderly'"),
      evidence: z.string().describe("One sentence on who they are in this excerpt"),
      voiceEvidence: z
        .string()
        .describe(
          "Textual evidence about this character's voice: accent, dialect, ethnicity/nationality, physical voice qualities, or appearing at different ages across the story; empty string if none"
        ),
      quotes: z
        .array(z.string())
        .describe("Up to 3 VERBATIM lines of dialogue spoken by this character"),
    })
  ),
});

const mergeSchema = z.object({
  pov: z.enum(["first", "third"]).describe("Narrative point of view of the prose"),
  narrator: z.object({
    description: z.string().describe("Who/what the narrating voice is"),
    tone: z.string().describe("Tone of the prose, e.g. 'wry, warm, unhurried'"),
    genderSuggestion: z.enum(["male", "female", "neutral"]),
  }),
  characters: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()),
      role: z.enum(["major", "minor"]),
      gender: z.enum(["male", "female", "nonbinary", "unknown"]),
      ageRange: z.string(),
      personality: z.string().describe("Short personality sketch"),
      speechStyle: z.string().describe("How they talk, e.g. 'clipped, formal'"),
      accentHint: z.string().describe("Accent/dialect if evident, else empty string"),
      heritage: z
        .string()
        .describe(
          "Ethnicity/nationality/cultural background AS EVIDENCED BY THE TEXT (e.g. 'Hawaiian', 'Russian émigré'); empty string if no evidence"
        ),
      voiceTexture: z
        .string()
        .describe(
          "Physical voice qualities, e.g. 'gravelly, deep' or 'bright, breathy'; empty string if no evidence"
        ),
      dialogueShare: z
        .number()
        .min(0)
        .max(1)
        .describe("Approximate fraction of the book's dialogue spoken by them"),
      quotes: z.array(z.string()).max(5).describe("3-5 best VERBATIM dialogue quotes"),
      ageVariants: z
        .array(
          z.object({
            label: z
              .string()
              .describe("Life stage: child | teen | young adult | adult | middle-aged | elderly"),
            ageRange: z.string().describe("Age at this stage, e.g. '8-10'"),
            speechStyle: z.string().describe("How they talk at this stage; empty to inherit"),
            dialogueShare: z
              .number()
              .min(0)
              .max(1)
              .describe("This stage's fraction of the book's dialogue"),
            quotes: z
              .array(z.string())
              .max(3)
              .describe("VERBATIM dialogue quotes from this life stage"),
          })
        )
        .describe(
          "ONLY for characters who clearly speak dialogue at distinctly different life stages; empty array for everyone else"
        ),
    })
  ),
});

export async function runAnalysis(bookId: string, jobId: string): Promise<void> {
  try {
    const book = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!book) throw new Error("Book not found");
    const bookChapters = db
      .select({ text: chapters.text })
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .orderBy(asc(chapters.idx))
      .all();

    const fullText = bookChapters.map((c) => c.text).join("\n\n");
    const chunks = chunkText(fullText, CHUNK_SIZE);
    setJobTotal(jobId, chunks.length + 1);

    // Map: extract character mentions per chunk (small concurrent pool)
    const chunkResults: z.infer<typeof chunkSchema>[] = new Array(chunks.length);
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        assertNotCancelled(jobId);
        const i = next++;
        const { object } = await generateObject({
          model: getModel("analyze", book!.modelPrefs),
          schema: chunkSchema,
          prompt:
            `This is excerpt ${i + 1} of ${chunks.length} from the book "${book!.title}". ` +
            `List every character who speaks dialogue or plays a meaningful part in this excerpt. ` +
            `Quotes must be copied VERBATIM from the text (dialogue only, no narration). ` +
            `In voiceEvidence, note anything the text says about how they SOUND — accent, dialect, ` +
            `ethnicity or nationality, physical voice descriptions — and whether they appear at ` +
            `distinctly different ages in this excerpt vs. elsewhere. ` +
            `Skip characters who are only mentioned in passing.\n\n---\n\n${chunks[i]}`,
        });
        chunkResults[i] = object;
        const names = new Set<string>();
        for (const r of chunkResults) {
          if (r) for (const c of r.characters) names.add(c.name.toLowerCase());
        }
        const done = chunkResults.filter(Boolean).length;
        tickJob(jobId, {
          note: `Reading section ${done}/${chunks.length} — ${names.size} characters so far`,
        });
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(LLM_CONCURRENCY, chunks.length) }, worker)
    );

    // Reduce: merge and dedupe into the final cast
    assertNotCancelled(jobId);
    noteJob(jobId, "Merging cast list…");
    const merged = await generateObject({
      model: getModel("analyze", book.modelPrefs),
      schema: mergeSchema,
      prompt:
        `Below are per-excerpt character extractions from the book "${book.title}" ` +
        `(${chunks.length} excerpts, ${fullText.length.toLocaleString()} characters of text). ` +
        `Merge them into one final cast list:\n` +
        `- Merge entries that are the same person under different names; put alternate names in aliases.\n` +
        `- role "major" for characters with substantial recurring dialogue, "minor" otherwise.\n` +
        `- Keep every character who speaks more than once or twice; at most 40 characters total.\n` +
        `- dialogueShare values should roughly sum to 1 across all characters.\n` +
        `- For each, pick their 3-5 most characterful VERBATIM quotes from the extractions.\n` +
        `- For EVERY character (including minors), fill heritage and voiceTexture strictly from textual evidence ` +
        `(explicit descriptions, dialect, corroborated names/setting) — empty strings when there is none; never guess from a name alone.\n` +
        `- If and ONLY if a character clearly speaks dialogue at distinctly different life stages ` +
        `(e.g. chapters set years apart), list 2-4 ageVariants using labels from: child, teen, young adult, adult, ` +
        `middle-aged, elderly — each with its own dialogueShare and quotes from that stage. Leave ageVariants empty ` +
        `for everyone else; do not split for minor aging within one stage. Variants count toward the 40-character cap.\n` +
        `- Also describe the narrating voice of the prose (not a character unless the book is first-person).\n\n` +
        JSON.stringify(chunkResults),
    });
    const { pov, narrator, characters: cast } = merged.object;
    tickJob(jobId, { note: `Found ${cast.length} characters` });
    const openingText = bookChapters[0]?.text.slice(0, 280) ?? "";

    db.transaction((tx) => {
      // Snapshot the outgoing cast so re-analysis is non-destructive: voice
      // assignments and script attributions are re-attached below wherever a
      // character's name (or alias) still matches.
      const oldCast = tx.select().from(characters).where(eq(characters.bookId, bookId)).all();
      const oldAssignments = oldCast.length
        ? tx
            .select()
            .from(voiceAssignments)
            .where(inArray(voiceAssignments.characterId, oldCast.map((c) => c.id)))
            .all()
        : [];
      const oldSegments = oldCast.length
        ? tx
            .select({ id: segments.id, characterId: segments.characterId })
            .from(segments)
            .innerJoin(chapters, eq(segments.chapterId, chapters.id))
            .where(eq(chapters.bookId, bookId))
            .all()
        : [];

      tx.delete(characters).where(eq(characters.bookId, bookId)).run();

      // Expand the merged cast into row specs: a character with clearly
      // distinct life stages becomes sibling variant rows ("Hugo Pitts (child)")
      // sharing a variantGroup. Naming/alias invariants are enforced here in
      // code — the name-preservation machinery depends on them.
      interface RowSpec {
        name: string;
        aliases: string[];
        role: "major" | "minor";
        profile: CharacterProfile;
        quotes: string[];
        dialogueShare: number;
        variantGroup: string | null;
        variantLabel: string | null;
      }
      const specs: RowSpec[] = [];
      for (const c of cast) {
        const baseProfile: CharacterProfile = {
          gender: c.gender,
          ageRange: c.ageRange,
          personality: c.personality,
          speechStyle: c.speechStyle,
          accentHint: c.accentHint,
          heritage: c.heritage,
          voiceTexture: c.voiceTexture,
        };
        if (c.ageVariants.length >= 2) {
          for (const v of c.ageVariants) {
            const label = v.label.trim().toLowerCase();
            const name = `${c.name} (${label})`;
            specs.push({
              name,
              aliases: dedupeAliases([c.name, ...c.aliases], name),
              role: c.role,
              profile: {
                ...baseProfile,
                ageRange: v.ageRange,
                ...(v.speechStyle.trim() ? { speechStyle: v.speechStyle } : {}),
              },
              quotes: (v.quotes.length > 0 ? v.quotes : c.quotes).map((q) => q.slice(0, 300)),
              dialogueShare: v.dialogueShare,
              variantGroup: c.name,
              variantLabel: label,
            });
          }
        } else {
          specs.push({
            name: c.name,
            aliases: dedupeAliases(c.aliases, c.name),
            role: c.role,
            profile: baseProfile,
            quotes: c.quotes.map((q) => q.slice(0, 300)),
            dialogueShare: c.dialogueShare,
            variantGroup: null,
            variantLabel: null,
          });
        }
      }
      // Dominant-first: under first-wins registration, the highest-share
      // variant claims the shared base-name alias (and thus inherits the old
      // row's assignment + segments on re-analysis).
      specs.sort((a, b) => b.dialogueShare - a.dialogueShare);

      const newIdByName = new Map<string, string>();
      const register = (name: string, id: string) => {
        const key = name.trim().toLowerCase();
        if (key && !newIdByName.has(key)) newIdByName.set(key, id);
      };

      const narratorId = randomUUID();
      tx.insert(characters)
        .values({
          id: narratorId,
          bookId,
          name: "Narrator",
          aliases: [],
          role: "narrator",
          profile: {
            gender: narrator.genderSuggestion === "neutral" ? "unknown" : narrator.genderSuggestion,
            ageRange: "adult",
            personality: narrator.description,
            speechStyle: narrator.tone,
            accentHint: "",
          },
          quotes: openingText ? [openingText] : [],
          dialogueShare: 0,
          isNarrator: true,
        })
        .run();
      register("Narrator", narratorId);

      const inserted: { spec: RowSpec; id: string }[] = [];
      for (const spec of specs) {
        const id = randomUUID();
        tx.insert(characters)
          .values({
            id,
            bookId,
            name: spec.name,
            aliases: spec.aliases,
            role: spec.role,
            profile: spec.profile,
            quotes: spec.quotes,
            dialogueShare: spec.dialogueShare,
            isNarrator: false,
            variantGroup: spec.variantGroup,
            variantLabel: spec.variantLabel,
          })
          .run();
        inserted.push({ spec, id });
      }
      // Two-pass registration so an exact name can never be shadowed by
      // another character's alias.
      for (const { spec, id } of inserted) register(spec.name, id);
      for (const { spec, id } of inserted) {
        for (const alias of spec.aliases) register(alias, id);
      }

      // User-edited profiles survive re-analysis, but only on an exact name
      // match — an alias match would clobber a variant's per-stage ageRange.
      const idByExactName = new Map(inserted.map(({ spec, id }) => [spec.name.toLowerCase(), id]));
      for (const old of oldCast) {
        if (!old.profileEdited || old.isNarrator) continue;
        const newId = idByExactName.get(old.name.toLowerCase());
        if (newId) {
          tx.update(characters)
            .set({ profile: old.profile, profileEdited: true })
            .where(eq(characters.id, newId))
            .run();
        }
      }

      const matchNewId = (old: (typeof oldCast)[number]): string | undefined => {
        for (const name of [old.name, ...old.aliases]) {
          const id = newIdByName.get(name.trim().toLowerCase());
          if (id) return id;
        }
        return undefined;
      };

      // Voice assignments carry over by name; manual overrides win merges.
      // Label drift ("boy" → "child") degrades gracefully: both old variants
      // alias-match the new dominant variant and the `taken` set keeps one.
      const assignmentByOldId = new Map(oldAssignments.map((a) => [a.characterId, a]));
      const taken = new Set<string>();
      const oldByOverriddenFirst = [...oldCast].sort(
        (a, b) =>
          Number(assignmentByOldId.get(b.id)?.overridden ?? false) -
          Number(assignmentByOldId.get(a.id)?.overridden ?? false)
      );
      for (const old of oldByOverriddenFirst) {
        const assignment = assignmentByOldId.get(old.id);
        const newId = matchNewId(old);
        if (!assignment || !newId || taken.has(newId)) continue;
        taken.add(newId);
        tx.insert(voiceAssignments)
          .values({ ...assignment, id: randomUUID(), characterId: newId })
          .run();
      }

      // Re-point script segments (the cascade already nulled them); dialogue
      // whose speaker vanished stays narrator-voiced but gets flagged.
      const oldById = new Map(oldCast.map((c) => [c.id, c]));
      for (const seg of oldSegments) {
        if (!seg.characterId) continue;
        const old = oldById.get(seg.characterId);
        const newId = old ? matchNewId(old) : undefined;
        if (newId) {
          tx.update(segments).set({ characterId: newId }).where(eq(segments.id, seg.id)).run();
        } else {
          tx.update(segments).set({ flagged: true }).where(eq(segments.id, seg.id)).run();
        }
      }

      tx.update(books)
        .set({ povType: pov, narratorProfile: narrator, status: "analyzed", error: null })
        .where(eq(books.id, bookId))
        .run();
    });

    completeJob(jobId);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      const hasCharacters =
        db.select({ id: characters.id }).from(characters).where(eq(characters.bookId, bookId)).limit(1).all()
          .length > 0;
      db.update(books)
        .set({ status: hasCharacters ? "analyzed" : "parsed", error: null })
        .where(eq(books.id, bookId))
        .run();
      return;
    }
    console.error("Analysis failed:", err);
    failJob(jobId, err);
    db.update(books)
      .set({ status: "error", error: err instanceof Error ? err.message : String(err) })
      .where(eq(books.id, bookId))
      .run();
  }
}

/** Case-insensitive dedupe, excluding the row's own name. */
function dedupeAliases(aliases: string[], ownName: string): string[] {
  const seen = new Set<string>([ownName.trim().toLowerCase()]);
  const out: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}
