import { eq } from "drizzle-orm";
import { getDb, chapters } from "@/lib/db";
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
