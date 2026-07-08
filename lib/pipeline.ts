import { and, asc, eq } from "drizzle-orm";
import { getDb, books, chapters, segments } from "@/lib/db";
import type { PipelineStage } from "@/lib/db/schema";

/**
 * Guided-setup state machine helper. Stage writes are conditional on the
 * expected current stage so a user Dismiss mid-run isn't clobbered when the
 * background workflow finishes. Failures never change the stage — the UI
 * derives "failed" from book/chapter/job errors and `retry` re-dispatches.
 */
export async function setStageIf(
  bookId: string,
  expected: PipelineStage,
  next: PipelineStage | null
): Promise<boolean> {
  const updated = await getDb()
    .update(books)
    .set({ pipelineStage: next })
    .where(and(eq(books.id, bookId), eq(books.pipelineStage, expected)))
    .returning({ id: books.id });
  return updated.length > 0;
}

/** The chapter used for the pipeline's listenable sample: first real chapter. */
export async function pickSampleChapter(bookId: string) {
  const rows = await getDb()
    .select({ id: chapters.id, idx: chapters.idx, title: chapters.title, status: chapters.status })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.idx));
  if (rows.length === 0) return undefined;
  return rows.find((c) => c.title !== "Front Matter") ?? rows[0];
}

export async function sampleHasScript(chapterId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: segments.id })
    .from(segments)
    .where(eq(segments.chapterId, chapterId))
    .limit(1);
  return rows.length > 0;
}
