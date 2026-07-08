import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { generateObject } from "ai";
import { z } from "zod";
import { getDb, books, chapters, characters, segments } from "@/lib/db";
import { getModel } from "@/lib/llm";
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
// Multi-row segment inserts, bounded so statements stay reasonably sized.
const INSERT_CHUNK = 50;

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

export type Attribution = z.infer<typeof attributionSchema>["quotes"][number];

// POV detection reads the chapter's opening (and ending, when long enough) —
// enough to tell first-person or epistolary prose from third-person.
const POV_HEAD_CHARS = 3_000;
const POV_TAIL_CHARS = 1_000;

const povSchema = z.object({
  narrator: z
    .string()
    .describe('Narrating character\'s name exactly as listed, or "narrator" for third-person prose'),
  confidence: z.enum(["high", "medium", "low"]),
});

interface FinalSegment {
  characterId: string | null; // null = narrator
  kind: "narration" | "dialogue";
  text: string;
  flagged: boolean;
}

const PERF_CHUNK_CHARS = 14_000;
export const MAX_SFX_PER_CHAPTER = 2;

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

export interface DeliveryNote {
  line: number;
  delivery: Delivery;
}
export interface SfxNote {
  afterLine: number;
  prompt: string;
  seconds: number;
}

/**
 * Everything scripting needs, re-derived deterministically from the DB —
 * cleaning and tokenization are pure, so workflow steps can each call this
 * instead of shipping spans between invocations.
 */
async function loadScriptContext(chapterId: string) {
  const db = getDb();
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId)).limit(1);
  if (!chapter) throw new Error("Chapter not found");
  const [book] = await db.select().from(books).where(eq(books.id, chapter.bookId)).limit(1);
  if (!book) throw new Error("Book not found");
  const cast = await db.select().from(characters).where(eq(characters.bookId, chapter.bookId));

  const text = cleanChapterText(chapter.text, chapter.title);
  const { spans } = tokenizeQuotes(text);
  // Quote order index: q-th quote span -> index into spans
  const quoteSpans: number[] = [];
  spans.forEach((s, i) => {
    if (s.kind === "quote") quoteSpans.push(i);
  });

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

  return { chapter, book, cast, text, spans, quoteSpans, nameList, hasVariants, byName };
}

/**
 * Decide who narrates the chapter's prose (one LLM call), and report how many
 * attribution chunks the chapter needs. First-person or epistolary chapters
 * are narrated by a character; their narration segments carry that
 * character's voice instead of the book's.
 */
export async function detectPovLlm(
  chapterId: string
): Promise<{ povCharacterId: string | null; attrChunkCount: number }> {
  const ctx = await loadScriptContext(chapterId);
  const { text, book, chapter, nameList, hasVariants, byName } = ctx;

  const head = text.slice(0, POV_HEAD_CHARS);
  const tail = text.length > POV_HEAD_CHARS + POV_TAIL_CHARS ? text.slice(-POV_TAIL_CHARS) : "";
  const { object } = await generateObject({
    model: getModel("script", book.modelPrefs),
    schema: povSchema,
    prompt:
      `You are preparing the audiobook script for "${book.title}".\n\n` +
      `Decide who narrates the PROSE of the chapter "${chapter.title}" — the voice telling it, ` +
      `not the characters quoted inside it.\n\n` +
      `Characters:\n${nameList}\n\n` +
      `Rules:\n` +
      `- Third-person or omniscient prose: "narrator".\n` +
      `- First-person prose, or a letter/diary/message a character writes: that character's name exactly as listed.\n` +
      (hasVariants
        ? `- Entries like "Name (child)" / "Name (adult)" are the SAME person at different life stages: pick the variant doing the telling (an adult recounting their childhood narrates as the adult).\n`
        : "") +
      `- If truly unclear, use "narrator" with confidence "low".\n\n` +
      `CHAPTER OPENING:\n${head}` +
      (tail ? `\n\nCHAPTER ENDING:\n${tail}` : ""),
  });

  let povCharacterId: string | null = null;
  if (object.confidence !== "low") {
    const key = object.narrator.trim().toLowerCase();
    if (key && key !== "narrator") povCharacterId = byName.get(key) ?? null;
  }
  const attrChunkCount =
    ctx.quoteSpans.length > 0 ? chunkQuotes(ctx.spans, ctx.quoteSpans).length : 0;
  return { povCharacterId, attrChunkCount };
}

/** One attribution chunk: name the speaker of every ⟦id⟧-marked quote in it. */
export async function attributeChunkLlm(
  chapterId: string,
  ci: number,
  recent: string[],
  povCharacterId: string | null
): Promise<{ attributions: Attribution[]; recent: string[]; quoteCount: number }> {
  const ctx = await loadScriptContext(chapterId);
  const { text, spans, quoteSpans, book, nameList, hasVariants, cast } = ctx;
  const chunks = chunkQuotes(spans, quoteSpans);
  const chunk = chunks[ci];
  if (!chunk) return { attributions: [], recent, quoteCount: 0 };
  const povName = povCharacterId
    ? (cast.find((c) => c.id === povCharacterId)?.name ?? null)
    : null;

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
      (povName
        ? `- This chapter's prose is narrated first-person by ${povName}: quotes the narrator speaks or thinks ("I said…") belong to ${povName}.\n`
        : "") +
      `- If the speaker is unnamed or truly unclear, use "narrator" with confidence "low".\n\n` +
      `PASSAGE:\n${passage}`,
  });

  const inRange = object.quotes.filter((q) => q.id >= chunk.from && q.id < chunk.to);
  // Rolling context for the next chunk: the last few attributions of this one
  const byId = new Map(inRange.map((q) => [q.id, q]));
  const nextRecent: string[] = [];
  for (let q = Math.max(chunk.from, chunk.to - 3); q < chunk.to; q++) {
    const a = byId.get(q);
    if (a) nextRecent.push(`⟦${q}⟧=${a.speaker}`);
  }
  return { attributions: inRange, recent: nextRecent, quoteCount: chunk.to - chunk.from };
}

/** Derived inputs shared by the performance-pass planning and chunk calls. */
async function buildPerformanceContext(
  chapterId: string,
  attributionList: Attribution[],
  povCharacterId: string | null
) {
  const ctx = await loadScriptContext(chapterId);
  const attributions = new Map<number, Attribution>();
  for (const a of attributionList) {
    if (!attributions.has(a.id)) attributions.set(a.id, a);
  }
  const resolved = assemble(ctx.spans, attributions, ctx.byName, ctx.chapter.title, povCharacterId);
  const nameById = new Map(ctx.cast.map((c) => [c.id, c.name]));
  const lines = resolved.map((seg, i) => {
    // Keyed on kind, not characterId — POV-narrated narration still reads
    // [Narration] so the voice director never marks delivery on it.
    const label =
      seg.kind === "dialogue" && seg.characterId
        ? (nameById.get(seg.characterId) ?? "?")
        : "Narration";
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

  return { ...ctx, resolved, lines, chunks };
}

/** How many performance-pass chunks the chapter needs (0 = skip the pass). */
export async function performancePlan(
  chapterId: string,
  attributionList: Attribution[],
  povCharacterId: string | null
): Promise<{ chunkCount: number }> {
  const ctx = await buildPerformanceContext(chapterId, attributionList, povCharacterId);
  const hasDialogue = ctx.resolved.some((s) => s.kind === "dialogue");
  if (!hasDialogue && !ctx.book.sfxEnabled) return { chunkCount: 0 };
  return { chunkCount: ctx.chunks.length };
}

/**
 * One voice-director chunk: sparse delivery notes on dialogue lines and (when
 * enabled) rare, text-evidenced sound effects. Everything the model returns
 * is re-validated in code — lines out of range, deliveries on narration,
 * unevidenced sounds are dropped (the per-chapter sfx cap is enforced by the
 * caller when merging chunks).
 */
export async function performanceChunkLlm(
  chapterId: string,
  attributionList: Attribution[],
  povCharacterId: string | null,
  ci: number
): Promise<{ deliveries: DeliveryNote[]; sfx: SfxNote[] }> {
  const ctx = await buildPerformanceContext(chapterId, attributionList, povCharacterId);
  const { book, chapter, lines, chunks, resolved, text } = ctx;
  const chunk = chunks[ci];
  if (!chunk) return { deliveries: [], sfx: [] };

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

  const { object } = await generateObject({
    model: getModel("script", book.modelPrefs),
    schema: performanceSchema,
    prompt:
      `You are the voice director for the audiobook of "${book.title}".\n\n` +
      `Below is part of the final numbered script for "${chapter.title}". Dialogue ` +
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

  const deliveries: DeliveryNote[] = [];
  for (const d of object.deliveries) {
    const seg = resolved[d.line];
    if (d.line >= chunk.from && d.line < chunk.to && seg?.kind === "dialogue") {
      deliveries.push({ line: d.line, delivery: d.delivery });
    }
  }
  const sfx: SfxNote[] = [];
  if (book.sfxEnabled) {
    for (const s of object.soundEffects) {
      const evidenced = s.evidence.trim().length > 0 && text.includes(s.evidence.trim());
      if (s.afterLine >= chunk.from && s.afterLine < chunk.to && evidenced && s.prompt.trim()) {
        const seconds = Math.round(Math.min(6, Math.max(1, s.seconds)) * 10) / 10;
        sfx.push({ afterLine: s.afterLine, prompt: s.prompt.trim(), seconds });
      }
    }
  }
  return { deliveries, sfx };
}

/**
 * Assemble the final segment rows and replace the chapter's script in one
 * transaction. Boundaries come from the deterministic quote tokenizer (no
 * words can be lost); the LLM only named each quote's speaker.
 */
export async function writeScript(
  chapterId: string,
  attributionList: Attribution[],
  deliveryNotes: DeliveryNote[],
  sfxNotes: SfxNote[],
  povCharacterId: string | null
): Promise<{ segmentCount: number; flagged: number }> {
  const ctx = await loadScriptContext(chapterId);
  const attributions = new Map<number, Attribution>();
  for (const a of attributionList) {
    if (!attributions.has(a.id)) attributions.set(a.id, a);
  }
  const resolved = assemble(ctx.spans, attributions, ctx.byName, ctx.chapter.title, povCharacterId);

  const deliveries = new Map<number, Delivery>();
  for (const d of deliveryNotes) {
    if (!deliveries.has(d.line)) deliveries.set(d.line, d.delivery);
  }
  const sfx = new Map<number, { prompt: string; seconds: number }>();
  for (const s of sfxNotes) {
    if (sfx.size >= MAX_SFX_PER_CHAPTER) break;
    if (!sfx.has(s.afterLine)) sfx.set(s.afterLine, { prompt: s.prompt, seconds: s.seconds });
  }

  // Build the full row set outside the transaction (pure computation).
  let flagged = 0;
  type SegmentRow = typeof segments.$inferInsert;
  const rows: SegmentRow[] = [];
  resolved.forEach((seg, line) => {
    if (seg.flagged) flagged++;
    rows.push({
      id: randomUUID(),
      chapterId,
      idx: rows.length,
      characterId: seg.characterId,
      kind: seg.kind,
      text: seg.text,
      textHash: createHash("sha256").update(seg.text).digest("hex"),
      flagged: seg.flagged,
      delivery: deliveries.get(line) ?? null,
    });
    const cue = sfx.get(line);
    if (cue) {
      rows.push({
        id: randomUUID(),
        chapterId,
        idx: rows.length,
        characterId: null,
        kind: "sfx",
        text: cue.prompt,
        textHash: createHash("sha256").update(cue.prompt).digest("hex"),
        flagged: false,
        sfxDurationSec: cue.seconds,
      });
    }
  });

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(segments).where(eq(segments.chapterId, chapterId));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(segments).values(rows.slice(i, i + INSERT_CHUNK));
    }
    await tx
      .update(chapters)
      .set({ status: "scripted", audioPath: null, durationSec: null, error: null })
      .where(eq(chapters.id, chapterId));
  });

  return { segmentCount: rows.length, flagged };
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
 * they stay individually reassignable in the script viewer). In a POV chapter
 * the narrating character voices the narration — and any quote that didn't
 * resolve to a listed character — while the title announcement stays with the
 * book's narrator.
 */
function assemble(
  spans: TextSpan[],
  attributions: Map<number, Attribution>,
  byName: Map<string, string>,
  title: string,
  povCharacterId: string | null
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
        out.push({
          characterId: povCharacterId,
          kind: "narration",
          text: piece,
          flagged: bufferFlagged,
        });
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
    // In a POV chapter every unattributed line is still the narrating
    // character's telling, so it keeps their voice.
    characterId ??= povCharacterId;

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
