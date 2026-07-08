import { and, asc, eq } from "drizzle-orm";
import { db, books, chapters, segments } from "@/lib/db";
import type { PipelineStage } from "@/lib/db/schema";
import { JobCancelledError } from "@/lib/errors";
import { completeJob, createJob, failJob, jobStatus, withHeartbeat } from "@/lib/jobs";
import { runAnalysis } from "@/lib/analysis/characters";
import { runCasting } from "@/lib/analysis/casting";
import { scriptChapter } from "@/lib/analysis/scripting";
import { generateChapter } from "@/lib/generation";

/**
 * Guided-setup state machine. Stage writes are conditional on the expected
 * current stage so a user Dismiss mid-run isn't clobbered when the background
 * job finishes. Failures never change the stage — the UI derives "failed"
 * from book/chapter/job errors and `retry` re-dispatches the same stage.
 */
export function setStageIf(
  bookId: string,
  expected: PipelineStage,
  next: PipelineStage | null
): boolean {
  const result = db
    .update(books)
    .set({ pipelineStage: next })
    .where(and(eq(books.id, bookId), eq(books.pipelineStage, expected)))
    .run();
  return result.changes > 0;
}

/** Analysis stage: runAnalysis handles its own job/errors; advance on success. */
export async function runAnalysisStage(bookId: string, jobId: string): Promise<void> {
  await withHeartbeat(jobId, () => runAnalysis(bookId, jobId));
  if (jobStatus(jobId) === "cancelled") {
    setStageIf(bookId, "analyzing", null);
    return;
  }
  const book = db
    .select({ status: books.status })
    .from(books)
    .where(eq(books.id, bookId))
    .get();
  if (book?.status === "analyzed") {
    setStageIf(bookId, "analyzing", "cast_review");
  }
}

/**
 * Casting as a tracked job (also used by the standalone Auto-cast button —
 * the stage update is a no-op unless the pipeline armed it).
 */
export async function runCastingJob(bookId: string, jobId: string): Promise<void> {
  try {
    await withHeartbeat(jobId, () => runCasting(bookId, jobId));
    completeJob(jobId);
    setStageIf(bookId, "casting", "voice_review");
  } catch (err) {
    if (err instanceof JobCancelledError) {
      db.update(books)
        .set({ status: "analyzed", error: null })
        .where(and(eq(books.id, bookId), eq(books.status, "casting")))
        .run();
      setStageIf(bookId, "casting", null);
      return;
    }
    console.error(`Casting failed (${bookId}):`, err);
    failJob(jobId, err);
    db.update(books)
      .set({ status: "error", error: err instanceof Error ? err.message : String(err) })
      .where(eq(books.id, bookId))
      .run();
  }
}

/** The chapter used for the pipeline's listenable sample: first real chapter. */
export function pickSampleChapter(bookId: string) {
  const rows = db
    .select({ id: chapters.id, idx: chapters.idx, title: chapters.title, status: chapters.status })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.idx))
    .all();
  if (rows.length === 0) return undefined;
  return rows.find((c) => c.title !== "Front Matter") ?? rows[0];
}

export function sampleHasScript(chapterId: string): boolean {
  return (
    db
      .select({ id: segments.id })
      .from(segments)
      .where(eq(segments.chapterId, chapterId))
      .limit(1)
      .all().length > 0
  );
}

/** Sample stage: script the chapter, then render it, then mark sample_ready. */
export async function runSampleStage(
  bookId: string,
  chapterId: string,
  scriptJobId: string
): Promise<void> {
  try {
    await withHeartbeat(scriptJobId, () => scriptChapter(chapterId, { jobId: scriptJobId }));
    completeJob(scriptJobId);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      db.update(chapters)
        .set({ status: sampleHasScript(chapterId) ? "scripted" : "pending", error: null })
        .where(eq(chapters.id, chapterId))
        .run();
      setStageIf(bookId, "scripting_sample", null);
      return;
    }
    console.error(`Sample scripting failed (${chapterId}):`, err);
    failJob(scriptJobId, err);
    db.update(chapters)
      .set({ status: "error", error: err instanceof Error ? err.message : String(err) })
      .where(eq(chapters.id, chapterId))
      .run();
    return; // stage stays scripting_sample; retry re-dispatches
  }
  setStageIf(bookId, "scripting_sample", "generating_sample");
  await generateSample(bookId, chapterId);
}

/** Render the already-scripted sample chapter (generateChapter self-manages errors). */
export async function generateSample(bookId: string, chapterId: string): Promise<void> {
  const jobId = createJob("generate", bookId, chapterId);
  await withHeartbeat(jobId, () => generateChapter(chapterId, jobId));
  if (jobStatus(jobId) === "cancelled") {
    setStageIf(bookId, "generating_sample", null);
    return;
  }
  const chapter = db
    .select({ status: chapters.status })
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .get();
  if (chapter?.status === "ready") {
    setStageIf(bookId, "generating_sample", "sample_ready");
  }
}
