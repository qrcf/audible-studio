import { runGenerateChapterPhase } from "./phase";

export type ChapterOutcome = "ready" | "cancelled" | "failed";

/**
 * Render one chapter, standalone (the chapter generate route and the sample
 * pipeline). Book-wide runs use chapterPipelineWorkflow instead, which chains
 * scripting + rendering under one job and reports back through a hook.
 */
export async function generateChapterWorkflow(
  chapterId: string,
  jobId: string
): Promise<ChapterOutcome> {
  "use workflow";
  const result = await runGenerateChapterPhase(chapterId, jobId);
  if (result.outcome === "failed") {
    throw new Error(result.error ?? "Generation failed"); // run shows failed
  }
  return result.outcome;
}
