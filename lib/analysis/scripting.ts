import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { db, books, chapters, characters, segments } from "@/lib/db";
import { getModel } from "@/lib/llm";
import { assertNotCancelled, setJobTotal, tickJob } from "@/lib/jobs";
import { DELIVERY_VALUES, type Delivery } from "@/lib/delivery";
import { cleanChapterText, titleAnnouncement } from "./clean";
import { tokenizeQuotes, type TextSpan } from "./tokenize";

const MAX_QUOTES_PER_CALL = 30;
const MAX_COVER_CHARS = 12_000;
const CONTEXT_PAD = 400; // context shown around a chunk's quotes
// Long narration is split at paragraph boundaries so the per-segment audio
// cache stays fine-grained (one fix shouldn't re-render thousands of chars);
// request-stitching makes the seams inaudible.
const NARRATION_SPLIT = 2_800;

const attributionSchema = z.object({
  quotes: z.array(
    z.object({
      id: z.number().int().describe("The ⟦id⟧ marker number"),
      speaker: z
        .string()
        .describe('Character name exactly as listed, or "narrator" if unnamed/unclear'),
      isDialogue: z
        .boolean()
        .describe(
          "false for signs, labels, inscriptions, quoted titles, scare quotes — quoted text nobody speaks aloud"
        ),
      confidence: z.enum(["high", "medium", "low"]),
    })
  ),
});

type Attribution = z.infer<typeof attributionSchema>["quotes"][number];

interface FinalSegment {
  characterId: string | null; // null = narrator
  kind: "narration" | "dialogue";
  text: string;
  flagged: boolean;
}

const PERF_CHUNK_CHARS = 14_000;
const MAX_SFX_PER_CHAPTER = 2;

const performanceSchema = z.object({
  deliveries: z.array(
    z.object({
      line: z.number().int().describe("The #N line number"),
      delivery: z.enum(DELIVERY_VALUES),
    })
  ),
  soundEffects: z.array(
    z.object({
      afterLine: z.number().int().describe("Insert after this #N line"),
      evidence: z
        .string()
        .describe("EXACT substring copied from the script that names the sound event"),
      prompt: z
        .string()
        .max(200)
        .describe("Concrete English sound description for a sound-effects generator"),
      seconds: z.number().min(1).max(6),
    })
  ),
});

interface PerformanceNotes {
  deliveries: Map<number, Delivery>;
  sfx: Map<number, { prompt: string; seconds: number }>;
}

/**
 * Turn a chapter into ordered voice-acting segments. Boundaries come from the
 * deterministic quote tokenizer (no words can be lost); the LLM only names
 * each quote's speaker.
 */
export async function scriptChapter(
  chapterId: string,
  opts: { jobId?: string } = {}
): Promise<{ segmentCount: number; flagged: number }> {
  const chapter = db.select().from(chapters).where(eq(chapters.id, chapterId)).get();
  if (!chapter) throw new Error("Chapter not found");
  const book = db.select().from(books).where(eq(books.id, chapter.bookId)).get();
  if (!book) throw new Error("Book not found");
  const cast = db
    .select()
    .from(characters)
    .where(eq(characters.bookId, chapter.bookId))
    .all();

  const text = cleanChapterText(chapter.text, chapter.title);
  const { spans } = tokenizeQuotes(text);
  // Quote order index: q-th quote span -> index into spans
  const quoteSpans: number[] = [];
  spans.forEach((s, i) => {
    if (s.kind === "quote") quoteSpans.push(i);
  });

  const attributions = new Map<number, Attribution>();
  let attrChunkCount = 0;
  if (quoteSpans.length > 0) {
    const chunks = chunkQuotes(spans, quoteSpans);
    attrChunkCount = chunks.length;
    if (opts.jobId) setJobTotal(opts.jobId, chunks.length);

    const nameList =
      cast
        .filter((c) => !c.isNarrator)
        .map((c) => {
          const aka = c.aliases.length ? ` (aka ${c.aliases.join(", ")})` : "";
          const variant = c.variantGroup ? ` — ${c.variantGroup} as: ${c.variantLabel}` : "";
          return `${c.name}${aka}${variant}`;
        })
        .join("\n") || '(none listed — use "narrator")';
    const hasVariants = cast.some((c) => c.variantGroup);

    let recent: string[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      if (opts.jobId) assertNotCancelled(opts.jobId);
      const chunk = chunks[ci];
      const passage = markupPassage(text, spans, quoteSpans, chunk);
      const { object } = await generateObject({
        model: getModel("script", book.modelPrefs),
        schema: attributionSchema,
        prompt:
          `You are attributing dialogue for an audiobook of "${book.title}".\n\n` +
          `In the passage below every quotation is wrapped in ⟦N⟧…⟦/N⟧ markers. ` +
          `Return one entry for EVERY marker id (${chunk.from}–${chunk.to - 1}).\n\n` +
          `Characters:\n${nameList}\n\n` +
          (recent.length
            ? `Attributions at the end of the previous passage: ${recent.join(", ")}\n\n`
            : "") +
          `Rules:\n` +
          `- speaker is a character name exactly as listed, or "narrator".\n` +
          `- Use dialogue tags ("said the Mouse") and conversational turn-taking for untagged quotes.\n` +
          `- Quoted thoughts ("thought Alice") count as dialogue by that character.\n` +
          `- A sign, label, inscription, letter, or quoted title nobody speaks aloud gets isDialogue=false and speaker "narrator".\n` +
          (hasVariants
            ? `- Entries like "Name (child)" / "Name (adult)" are the SAME person at different life stages: attribute each quote to the variant matching the scene's time period, using the exact listed name.\n`
            : "") +
          `- If the speaker is unnamed or truly unclear, use "narrator" with confidence "low".\n\n` +
          `PASSAGE:\n${passage}`,
      });
      for (const q of object.quotes) {
        if (q.id >= chunk.from && q.id < chunk.to && !attributions.has(q.id)) {
          attributions.set(q.id, q);
        }
      }
      recent = [];
      for (let q = Math.max(chunk.from, chunk.to - 3); q < chunk.to; q++) {
        const a = attributions.get(q);
        if (a) recent.push(`⟦${q}⟧=${a.speaker}`);
      }
      if (opts.jobId) {
        tickJob(opts.jobId, {
          note: `Identifying speakers ${ci + 1}/${chunks.length} (${chunk.to - chunk.from} quotes)`,
        });
      }
    }
  }

  // Deterministic resolution: exact names first, then aliases from dominant
  // characters down (first-wins) — so a shared alias like "Hugo" resolves to
  // the highest-share variant instead of whichever row happened to come last.
  const byName = new Map<string, string>();
  const speakers = cast
    .filter((c) => !c.isNarrator)
    .sort((a, b) => b.dialogueShare - a.dialogueShare);
  for (const c of speakers) {
    const key = c.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, c.id);
  }
  for (const c of speakers) {
    for (const alias of c.aliases) {
      const key = alias.trim().toLowerCase();
      if (key && !byName.has(key)) byName.set(key, c.id);
    }
  }

  const resolved = assemble(spans, attributions, byName, chapter.title);

  // Voice-director pass: per-line delivery notes + rare sound-effect cues.
  // Runs before the write transaction, so cancelling leaves the old script intact.
  const nameById = new Map(cast.map((c) => [c.id, c.name]));
  const hasDialogue = resolved.some((s) => s.kind === "dialogue");
  const notes: PerformanceNotes =
    hasDialogue || book.sfxEnabled
      ? await performancePass(resolved, nameById, book, chapter.title, text, {
          ...opts,
          attrChunkCount,
        })
      : { deliveries: new Map(), sfx: new Map() };

  let flagged = 0;
  let rowCount = 0;
  db.transaction((tx) => {
    tx.delete(segments).where(eq(segments.chapterId, chapterId)).run();
    let idx = 0;
    resolved.forEach((seg, line) => {
      if (seg.flagged) flagged++;
      tx.insert(segments)
        .values({
          id: randomUUID(),
          chapterId,
          idx: idx++,
          characterId: seg.characterId,
          kind: seg.kind,
          text: seg.text,
          textHash: createHash("sha256").update(seg.text).digest("hex"),
          flagged: seg.flagged,
          delivery: notes.deliveries.get(line) ?? null,
        })
        .run();
      const sfx = notes.sfx.get(line);
      if (sfx) {
        tx.insert(segments)
          .values({
            id: randomUUID(),
            chapterId,
            idx: idx++,
            characterId: null,
            kind: "sfx",
            text: sfx.prompt,
            textHash: createHash("sha256").update(sfx.prompt).digest("hex"),
            flagged: false,
            sfxDurationSec: sfx.seconds,
          })
          .run();
      }
    });
    rowCount = idx;
    tx.update(chapters)
      .set({ status: "scripted", audioPath: null, durationSec: null, error: null })
      .where(eq(chapters.id, chapterId))
      .run();
  });

  return { segmentCount: rowCount, flagged };
}

/**
 * One pass over the assembled script asking a "voice director" for sparse
 * delivery notes on dialogue lines and (when enabled) at most a couple of
 * concrete, text-evidenced sound effects. Everything the model returns is
 * re-validated in code — lines out of range, deliveries on narration,
 * unevidenced sounds, and anything past the per-chapter cap are dropped.
 */
async function performancePass(
  resolved: FinalSegment[],
  nameById: Map<string, string>,
  book: typeof books.$inferSelect,
  chapterTitle: string,
  cleanedText: string,
  opts: { jobId?: string; attrChunkCount: number }
): Promise<PerformanceNotes> {
  const lines = resolved.map((seg, i) => {
    const label = seg.characterId ? (nameById.get(seg.characterId) ?? "?") : "Narration";
    return `#${i} [${label}]: ${seg.text}`;
  });

  // Chunk on segment boundaries so line numbers stay chapter-global
  const chunks: { from: number; to: number }[] = [];
  let from = 0;
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > from && size + lines[i].length > PERF_CHUNK_CHARS) {
      chunks.push({ from, to: i });
      from = i;
      size = 0;
    }
    size += lines[i].length;
  }
  chunks.push({ from, to: lines.length });

  if (opts.jobId) setJobTotal(opts.jobId, opts.attrChunkCount + chunks.length);

  const sfxJob = book.sfxEnabled
    ? `2. SOUND EFFECTS — almost always NONE. You may insert a sound effect after a\n` +
      `   line ONLY when that line explicitly narrates a single concrete percussive\n` +
      `   sound event at a specific moment: a door slams, a thunderclap, glass\n` +
      `   shatters, a train whistle, a gunshot, a heavy fall. Rules:\n` +
      `   - The sound must be a discrete EVENT the text names, not atmosphere: never\n` +
      `     ambience, music, weather mood, crowd murmur, birdsong, or anything continuous.\n` +
      `   - evidence: copy the exact words from the script that name the sound.\n` +
      `   - prompt: a short concrete description for a sound generator, e.g.\n` +
      `     "a heavy wooden door slams shut, close-up, interior".\n` +
      `   - seconds: 1-6, as short as plausible.\n` +
      `   - Most chapters have ZERO sound effects. If in doubt, return none. Never\n` +
      `     more than one for this excerpt.`
    : `2. SOUND EFFECTS — disabled for this book. Return soundEffects as an empty array.`;

  const deliveries = new Map<number, Delivery>();
  const sfx = new Map<number, { prompt: string; seconds: number }>();

  for (let ci = 0; ci < chunks.length; ci++) {
    if (opts.jobId) assertNotCancelled(opts.jobId);
    const chunk = chunks[ci];
    const { object } = await generateObject({
      model: getModel("script", book.modelPrefs),
      schema: performanceSchema,
      prompt:
        `You are the voice director for the audiobook of "${book.title}".\n\n` +
        `Below is part of the final numbered script for "${chapterTitle}". Dialogue ` +
        `lines show their speaker; narration lines are marked [Narration].\n\n` +
        `Two jobs:\n\n` +
        `1. DELIVERY NOTES — for DIALOGUE lines only. Mark a line ONLY when the text\n` +
        `   makes the delivery unmistakable: an explicit tag ("she whispered", "he\n` +
        `   roared"), or an unambiguous situation (screaming for help, sobbing while\n` +
        `   speaking). A good narrator reads most lines with no note — mark at most 1\n` +
        `   line in 6, and prefer fewer. Never mark [Narration] lines.\n` +
        `   Allowed values: ${DELIVERY_VALUES.join(", ")}.\n\n` +
        `${sfxJob}\n\n` +
        `Return empty arrays when nothing qualifies.\n\n` +
        `SCRIPT:\n${lines.slice(chunk.from, chunk.to).join("\n")}`,
    });

    for (const d of object.deliveries) {
      const seg = resolved[d.line];
      if (
        d.line >= chunk.from &&
        d.line < chunk.to &&
        seg?.kind === "dialogue" &&
        !deliveries.has(d.line)
      ) {
        deliveries.set(d.line, d.delivery);
      }
    }
    if (book.sfxEnabled) {
      for (const s of object.soundEffects) {
        if (sfx.size >= MAX_SFX_PER_CHAPTER) break;
        const evidenced = s.evidence.trim().length > 0 && cleanedText.includes(s.evidence.trim());
        if (
          s.afterLine >= chunk.from &&
          s.afterLine < chunk.to &&
          evidenced &&
          s.prompt.trim() &&
          !sfx.has(s.afterLine)
        ) {
          const seconds = Math.round(Math.min(6, Math.max(1, s.seconds)) * 10) / 10;
          sfx.set(s.afterLine, { prompt: s.prompt.trim(), seconds });
        }
      }
    }
    if (opts.jobId) {
      tickJob(opts.jobId, { note: `Performance notes ${ci + 1}/${chunks.length}` });
    }
  }

  return { deliveries, sfx };
}

/** Group consecutive quotes into attribution calls bounded by count and span. */
function chunkQuotes(spans: TextSpan[], quoteSpans: number[]): { from: number; to: number }[] {
  const chunks: { from: number; to: number }[] = [];
  let from = 0;
  while (from < quoteSpans.length) {
    let to = from + 1;
    while (
      to < quoteSpans.length &&
      to - from < MAX_QUOTES_PER_CALL &&
      spans[quoteSpans[to]].end - spans[quoteSpans[from]].start <= MAX_COVER_CHARS
    ) {
      to++;
    }
    chunks.push({ from, to });
    from = to;
  }
  return chunks;
}

/** The chunk's covering text with each quote wrapped in ⟦id⟧…⟦/id⟧ markers. */
function markupPassage(
  text: string,
  spans: TextSpan[],
  quoteSpans: number[],
  chunk: { from: number; to: number }
): string {
  const first = spans[quoteSpans[chunk.from]];
  const last = spans[quoteSpans[chunk.to - 1]];
  const coverStart = Math.max(0, first.start - CONTEXT_PAD);
  const coverEnd = Math.min(text.length, last.end + CONTEXT_PAD);

  let out = coverStart > 0 ? "…" : "";
  let pos = coverStart;
  for (let q = chunk.from; q < chunk.to; q++) {
    const s = spans[quoteSpans[q]];
    out += `${text.slice(pos, s.start)}⟦${q}⟧${s.text}⟦/${q}⟧`;
    pos = s.end;
  }
  out += text.slice(pos, coverEnd) + (coverEnd < text.length ? "…" : "");
  return out;
}

/**
 * Walk the spans into final segments: narration (and non-spoken quotes) flow
 * into a buffer split at ~NARRATION_SPLIT on paragraph boundaries; spoken
 * quotes become dialogue segments (kept separate even when narrator-voiced so
 * they stay individually reassignable in the script viewer).
 */
function assemble(
  spans: TextSpan[],
  attributions: Map<number, Attribution>,
  byName: Map<string, string>,
  title: string
): FinalSegment[] {
  const out: FinalSegment[] = [];
  const announce = titleAnnouncement(title);
  if (announce) {
    out.push({ characterId: null, kind: "narration", text: announce, flagged: false });
  }

  let buffer = "";
  let bufferFlagged = false;
  const flushNarration = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      for (const piece of splitNarration(trimmed)) {
        out.push({ characterId: null, kind: "narration", text: piece, flagged: bufferFlagged });
      }
    }
    buffer = "";
    bufferFlagged = false;
  };

  let q = -1;
  for (const span of spans) {
    if (span.kind === "narration") {
      buffer += span.text;
      continue;
    }
    q++;
    const att = attributions.get(q);

    // Quotes nobody speaks aloud (signs, titles) stay in the narrator's flow.
    if (att && !att.isDialogue) {
      buffer += span.text;
      bufferFlagged = bufferFlagged || span.flagged || att.confidence === "low";
      continue;
    }

    let characterId: string | null = null;
    let flagged = span.flagged || !att || att.confidence === "low";
    if (att && att.speaker.toLowerCase() !== "narrator") {
      characterId = byName.get(att.speaker.toLowerCase()) ?? null;
      if (!characterId) flagged = true; // unknown speaker name — review
    }

    const gap = buffer;
    if (gap.trim()) {
      flushNarration();
    } else {
      buffer = "";
      bufferFlagged = false;
    }
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === "dialogue" &&
      characterId !== null &&
      prev.characterId === characterId &&
      !gap.trim()
    ) {
      // Same speaker continues across a whitespace-only gap (e.g. poem stanzas)
      prev.text += (gap || " ") + span.text;
      prev.flagged = prev.flagged || flagged;
    } else {
      out.push({
        characterId,
        kind: characterId ? "dialogue" : "narration",
        text: span.text,
        flagged,
      });
    }
  }
  flushNarration();

  return out.filter((seg) => seg.text.length > 0);
}

/** Split long narration at paragraph boundaries; short pieces pass through. */
function splitNarration(text: string): string[] {
  if (text.length <= NARRATION_SPLIT) return [text];
  const paragraphs = text.split(/\n\n+/);
  const pieces: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > NARRATION_SPLIT) {
      pieces.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) pieces.push(current);
  return pieces;
}
