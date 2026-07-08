import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { FatalError, RetryableError, getStepMetadata } from "workflow";
import { resumeHook } from "workflow/api";
import { getDb, books, chapters, characters, segments } from "@/lib/db";
import {
  CONTEXT_CHARS,
  DEFAULT_SFX_SECONDS,
  getAssignmentResolver,
  refreshBookStatus,
  renderPlan,
} from "@/lib/generation";
import { ttsConvert, splitForModel } from "@/lib/elevenlabs/tts";
import { soundEffect } from "@/lib/elevenlabs/sfx";
import { generateMusic, INTRO_MUSIC_PROMPT } from "@/lib/elevenlabs/music";
import { estimateSfxCredits } from "@/lib/format";
import { concatMp3, segmentAudioDurationSec } from "@/lib/audio/mp3";
import { isV3, pauseSuffix } from "@/lib/delivery";
import { titleAnnouncement } from "@/lib/analysis/clean";
import {
  chapterAudioPath,
  deleteBlobs,
  readAudio,
  readBlobIfExists,
  segmentAudioPath,
  writeAudio,
} from "@/lib/storage";
import { completeJob, failJob, isCancelled, setJobProgress, setJobTotal } from "@/lib/jobs";
import { ElevenLabsError } from "@/lib/errors";

/** The v2 prosody stitch chain, handed from one render batch to the next. */
export interface StitchChain {
  voiceId: string;
  requestIds: string[];
}

export interface BatchResult {
  cancelled: boolean;
  nextIdx: number;
  chain: StitchChain | null;
  charsUsed: number;
}

// A batch renders sequentially until the soft wall-clock budget or segment
// cap is hit, then returns a cursor — keeps every invocation far inside the
// 800s function ceiling regardless of chapter size.
const SOFT_BUDGET_MS = 550_000;
const MAX_SEGMENTS_PER_BATCH = 25;

/** Run an ElevenLabs call, mapping its failures onto workflow retry semantics. */
async function withElevenRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      if (err.retryable) {
        const attempt = getStepMetadata().attempt;
        throw new RetryableError(err.message, { retryAfter: attempt ** 2 * 1000 });
      }
      throw new FatalError(err.message);
    }
    throw err;
  }
}

export async function prepareChapter(
  chapterId: string,
  jobId: string
): Promise<{ total: number; bookId: string }> {
  "use step";
  const db = getDb();
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId)).limit(1);
  if (!chapter) throw new FatalError("Chapter not found");
  const segs = await db
    .select({ id: segments.id, characterId: segments.characterId, kind: segments.kind })
    .from(segments)
    .where(eq(segments.chapterId, chapterId))
    .orderBy(asc(segments.idx));
  if (segs.length === 0) throw new FatalError("Chapter has no script yet");

  const { missingNames } = await getAssignmentResolver(chapter.bookId);
  const missing = missingNames(segs.filter((s) => s.kind !== "sfx"));
  if (missing.length > 0) {
    throw new FatalError(`No voice assigned for: ${missing.join(", ")}. Cast voices first.`);
  }

  await setJobTotal(jobId, segs.length);
  await db
    .update(chapters)
    .set({ status: "generating", error: null })
    .where(eq(chapters.id, chapterId));
  return { total: segs.length, bookId: chapter.bookId };
}

export async function renderBatch(
  chapterId: string,
  jobId: string,
  fromIdx: number,
  chain: StitchChain | null,
  charsBefore: number
): Promise<BatchResult> {
  "use step";
  const started = Date.now();
  const db = getDb();
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId)).limit(1);
  if (!chapter) throw new FatalError("Chapter not found");
  const [book] = await db.select().from(books).where(eq(books.id, chapter.bookId)).limit(1);
  if (!book) throw new FatalError("Book not found");
  const segs = await db
    .select()
    .from(segments)
    .where(eq(segments.chapterId, chapterId))
    .orderBy(asc(segments.idx));
  const { resolve } = await getAssignmentResolver(chapter.bookId);
  const nameRows = await db
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(eq(characters.bookId, chapter.bookId));
  const nameById = new Map(nameRows.map((c) => [c.id, c.name]));

  // Prosody conditioning must come from neighboring SPEECH, never from a
  // sound-effect prompt, and always from the raw (untagged) text.
  const neighborText = (from: number, dir: -1 | 1): string | undefined => {
    for (let j = from + dir; j >= 0 && j < segs.length; j += dir) {
      if (segs[j].kind !== "sfx") return segs[j].text;
    }
    return undefined;
  };

  let chainVoiceId = chain?.voiceId ?? null;
  let chainRequestIds = chain?.requestIds ?? [];
  let chars = charsBefore;

  for (let i = fromIdx; i < segs.length; i++) {
    // Stop spending credits promptly on cancel
    if (await isCancelled(jobId)) {
      return { cancelled: true, nextIdx: i, chain: null, charsUsed: chars };
    }
    // Yield the invocation before the budget runs out; the workflow loops
    if (i > fromIdx && (Date.now() - started > SOFT_BUDGET_MS || i - fromIdx >= MAX_SEGMENTS_PER_BATCH)) {
      return {
        cancelled: false,
        nextIdx: i,
        chain: chainVoiceId ? { voiceId: chainVoiceId, requestIds: chainRequestIds } : null,
        charsUsed: chars,
      };
    }
    const seg = segs[i];

    if (seg.kind === "sfx") {
      const seconds = seg.sfxDurationSec ?? DEFAULT_SFX_SECONDS;
      const cacheKey = createHash("sha256")
        .update(JSON.stringify([seg.text, seconds, "sfx-v2"]))
        .digest("hex");
      const relPath = segmentAudioPath(chapter.bookId, cacheKey);
      let fresh = false;
      let sfxAudio = await readBlobIfExists(relPath);
      if (!sfxAudio) {
        sfxAudio = await withElevenRetry(() =>
          soundEffect({ text: seg.text, durationSec: seconds })
        );
        await writeAudio(relPath, sfxAudio);
        fresh = true;
      }
      chainVoiceId = null;
      chainRequestIds = [];
      await db
        .update(segments)
        .set({ audioPath: relPath, durationSec: segmentAudioDurationSec(sfxAudio) })
        .where(eq(segments.id, seg.id));
      if (fresh) chars += estimateSfxCredits(seconds);
      await setJobProgress(jobId, {
        done: i + 1,
        charsUsed: chars,
        note: `Sound effect — ${seg.text}${fresh ? "" : " (cached)"}`,
      });
      continue;
    }

    const assignment = resolve(seg.characterId)!;
    const plan = renderPlan(seg, assignment.settings, book.renderModel);
    // Give the chapter-title announcement a breath before the first line.
    if (seg.kind === "narration" && seg.text === titleAnnouncement(chapter.title)) {
      plan.renderedText += pauseSuffix(book.renderModel);
    }
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify([
          plan.renderedText,
          assignment.voiceId,
          plan.settings,
          book.renderModel,
          assignment.seed,
        ])
      )
      .digest("hex");
    const relPath = segmentAudioPath(chapter.bookId, cacheKey);

    let freshChars = 0;
    let segAudio = await readBlobIfExists(relPath);
    if (segAudio) {
      // Cached audio has no request id — the chain breaks here
      chainVoiceId = null;
      chainRequestIds = [];
    } else {
      const pieces = splitForModel(plan.renderedText, book.renderModel);
      const pieceBuffers: Buffer[] = [];
      if (chainVoiceId !== assignment.voiceId) {
        chainVoiceId = assignment.voiceId;
        chainRequestIds = [];
      }
      for (let p = 0; p < pieces.length; p++) {
        const previousText =
          p > 0 ? pieces[p - 1].slice(-CONTEXT_CHARS) : neighborText(i, -1)?.slice(-CONTEXT_CHARS);
        const nextText =
          p < pieces.length - 1
            ? pieces[p + 1].slice(0, CONTEXT_CHARS)
            : neighborText(i, 1)?.slice(0, CONTEXT_CHARS);
        const result = await withElevenRetry(() =>
          ttsConvert({
            voiceId: assignment.voiceId,
            text: pieces[p],
            modelId: book.renderModel,
            settings: plan.settings,
            seed: assignment.seed,
            previousText,
            nextText,
            previousRequestIds: chainRequestIds,
          })
        );
        pieceBuffers.push(result.audio);
        // v3 has no request stitching — don't accumulate a dead chain
        if (!isV3(book.renderModel) && result.requestId) {
          chainRequestIds = [...chainRequestIds, result.requestId].slice(-3);
        }
        freshChars += pieces[p].length;
      }
      segAudio = pieceBuffers.length === 1 ? pieceBuffers[0] : concatMp3(pieceBuffers).data;
      await writeAudio(relPath, segAudio);
    }

    await db
      .update(segments)
      .set({ audioPath: relPath, durationSec: segmentAudioDurationSec(segAudio) })
      .where(eq(segments.id, seg.id));
    chars += freshChars;
    const speaker = seg.characterId ? (nameById.get(seg.characterId) ?? "?") : "Narrator";
    await setJobProgress(jobId, {
      done: i + 1,
      charsUsed: chars,
      note: `Segment ${i + 1}/${segs.length} — ${speaker}${freshChars === 0 ? " (cached)" : ""}`,
    });
  }

  return {
    cancelled: false,
    nextIdx: segs.length,
    chain: chainVoiceId ? { voiceId: chainVoiceId, requestIds: chainRequestIds } : null,
    charsUsed: chars,
  };
}

/**
 * Book intro for the first real chapter: cheesy music then the narrator
 * reading "{Title}, by {Author}." Returns the composed audio (cached per
 * book/title/author/voice) or null when this chapter isn't the intro chapter.
 * The intro isn't a segment — its duration is returned so read-along can
 * offset the chapter's segment start times past it.
 */
async function buildBookIntro(chapter: typeof chapters.$inferSelect): Promise<Buffer | null> {
  const db = getDb();
  const bookChapters = await db
    .select({ id: chapters.id, idx: chapters.idx, title: chapters.title })
    .from(chapters)
    .where(eq(chapters.bookId, chapter.bookId))
    .orderBy(asc(chapters.idx));
  const firstReal = bookChapters.find((c) => c.title !== "Front Matter") ?? bookChapters[0];
  if (!firstReal || firstReal.id !== chapter.id) return null;

  const [book] = await db.select().from(books).where(eq(books.id, chapter.bookId)).limit(1);
  if (!book) return null;
  const { resolve } = await getAssignmentResolver(chapter.bookId);
  const narrator = resolve(null);
  if (!narrator) return null; // narrator uncast — skip the intro rather than fail

  const introText = book.author ? `${book.title}, by ${book.author}.` : `${book.title}.`;
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        book.title,
        book.author ?? "",
        narrator.voiceId,
        narrator.settings,
        book.renderModel,
        "intro-v1",
      ])
    )
    .digest("hex")
    .slice(0, 16);
  const introPath = `intro/${book.id}/${key}.mp3`;

  const cached = await readBlobIfExists(introPath);
  if (cached) return cached;

  const music = await withElevenRetry(() => generateMusic(INTRO_MUSIC_PROMPT, 8000));
  const voice = await withElevenRetry(() =>
    ttsConvert({
      voiceId: narrator.voiceId,
      text: introText,
      modelId: book.renderModel,
      settings: narrator.settings,
      seed: narrator.seed,
    })
  );
  const intro = concatMp3([music, voice.audio]).data;
  await writeAudio(introPath, intro);
  return intro;
}

/** Concatenate the rendered segments into the chapter mp3 and mark it ready. */
export async function finalizeChapter(chapterId: string, jobId: string): Promise<void> {
  "use step";
  const db = getDb();
  const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapterId)).limit(1);
  if (!chapter) throw new FatalError("Chapter not found");
  const segs = await db
    .select({ audioPath: segments.audioPath })
    .from(segments)
    .where(eq(segments.chapterId, chapterId))
    .orderBy(asc(segments.idx));

  const buffers: Buffer[] = [];
  for (const seg of segs) {
    if (!seg.audioPath) throw new FatalError("Segment lost its audio — regenerate the chapter");
    buffers.push(await readAudio(seg.audioPath));
  }

  const intro = await buildBookIntro(chapter);
  const introDurationSec = intro ? segmentAudioDurationSec(intro) : null;
  const { data, durationSec } = concatMp3(intro ? [intro, ...buffers] : buffers);
  const contentHash = createHash("sha256").update(data).digest("hex").slice(0, 12);
  const chapterRel = chapterAudioPath(chapter.bookId, chapter.idx, contentHash);
  await writeAudio(chapterRel, data);

  await db
    .update(chapters)
    .set({ status: "ready", audioPath: chapterRel, durationSec, introDurationSec, error: null })
    .where(eq(chapters.id, chapterId));
  // The old version is unreachable once the row points at the new blob
  if (chapter.audioPath && chapter.audioPath !== chapterRel) {
    await deleteBlobs(chapter.audioPath);
  }
  await completeJob(jobId);
  await refreshBookStatus(chapter.bookId);
}

/** Rendered segments stay cached; the chapter just isn't assembled. */
export async function unwindChapterCancelled(chapterId: string, bookId: string): Promise<void> {
  "use step";
  await getDb()
    .update(chapters)
    .set({ status: "scripted", error: null })
    .where(eq(chapters.id, chapterId));
  await refreshBookStatus(bookId);
}

export async function failChapter(
  chapterId: string,
  bookId: string,
  jobId: string,
  message: string
): Promise<void> {
  "use step";
  console.error(`Chapter generation failed (${chapterId}):`, message);
  await failJob(jobId, message);
  await getDb()
    .update(chapters)
    .set({ status: "error", error: message })
    .where(eq(chapters.id, chapterId));
  await refreshBookStatus(bookId);
}

/** Child runs report their outcome to the waiting generate-book parent. */
export async function notifyParent(
  token: string,
  outcome: "ready" | "cancelled" | "failed"
): Promise<void> {
  "use step";
  await resumeHook(token, { outcome });
}
