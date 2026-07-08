import { runScriptPhase } from "../script-chapter/phase";
import { runGenerateChapterPhase } from "../generate-chapter/phase";
import { completeJobStep, createGenerateJobStep, setStageIfStep } from "../shared/steps";

/**
 * Guided-pipeline sample: script the sample chapter, then render it, then
 * arm the listen step. Failures leave the stage in place so Retry re-runs
 * the same stage; cancels disarm the pipeline (stage → null).
 */
export async function sampleStageWorkflow(
  bookId: string,
  chapterId: string,
  scriptJobId: string
): Promise<void> {
  "use workflow";
  const s = await runScriptPhase(chapterId, scriptJobId);
  if (s.outcome === "cancelled") {
    await setStageIfStep(bookId, "scripting_sample", null);
    return;
  }
  if (s.outcome === "failed") {
    return; // stage stays scripting_sample; retry re-dispatches
  }
  await completeJobStep(scriptJobId);
  await setStageIfStep(bookId, "scripting_sample", "generating_sample");
  await runSampleGenerate(bookId, chapterId);
}

/** Render-only path (retry after a failed sample render, or skip-ahead). */
export async function sampleGenerateWorkflow(bookId: string, chapterId: string): Promise<void> {
  "use workflow";
  await runSampleGenerate(bookId, chapterId);
}

async function runSampleGenerate(bookId: string, chapterId: string): Promise<void> {
  const jobId = await createGenerateJobStep(bookId, chapterId);
  const g = await runGenerateChapterPhase(chapterId, jobId);
  if (g.outcome === "cancelled") {
    await setStageIfStep(bookId, "generating_sample", null);
    return;
  }
  if (g.outcome === "ready") {
    await setStageIfStep(bookId, "generating_sample", "sample_ready");
  }
  // failed: stage stays generating_sample; the chapter row carries the error
}
