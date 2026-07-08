import { eq } from "drizzle-orm";
import { getDb, chapters, segments } from "@/lib/db";
import type { ChapterStatus, PipelineStage } from "@/lib/db/schema";
import { completeJob, createJob, failJob, noteJob } from "@/lib/jobs";
import { setStageIf } from "@/lib/pipeline";

export async function completeJobStep(jobId: string): Promise<void> {
  "use step";
  await completeJob(jobId);
}

export async function failJobStep(jobId: string, message: string): Promise<void> {
  "use step";
  await failJob(jobId, message);
}

export async function noteJobStep(jobId: string, note: string): Promise<void> {
  "use step";
  await noteJob(jobId, note);
}

export async function createGenerateJobStep(bookId: string, chapterId: string): Promise<string> {
  "use step";
  return createJob("generate", bookId, chapterId);
}

export async function setStageIfStep(
  bookId: string,
  expected: PipelineStage,
  next: PipelineStage | null
): Promise<boolean> {
  "use step";
  return setStageIf(bookId, expected, next);
}

export async function getChapterStatus(chapterId: string): Promise<ChapterStatus | null> {
  "use step";
  const [row] = await getDb()
    .select({ status: chapters.status })
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .limit(1);
  return row?.status ?? null;
}

/** True once the chapter has any segments (used to decide script-if-needed). */
export async function chapterHasScript(chapterId: string): Promise<boolean> {
  "use step";
  const rows = await getDb()
    .select({ id: segments.id })
    .from(segments)
    .where(eq(segments.chapterId, chapterId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Best-effort nudge to the bounded queue after a chapter workflow ends, so the
 * next queued job starts server-side without a book page open. A missed ping is
 * harmless — the progress-poll backstop drains the queue while the UI is open.
 */
export async function pingDispatch(appUrl: string, secret: string): Promise<void> {
  "use step";
  if (!appUrl) return;
  try {
    await fetch(`${appUrl}/api/internal/dispatch`, {
      method: "POST",
      headers: secret ? { "x-dispatch-secret": secret } : {},
    });
  } catch (err) {
    console.warn("dispatch ping failed:", err);
  }
}
