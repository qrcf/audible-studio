import { runScriptPhase } from "./phase";
import { completeJobStep } from "../shared/steps";

/**
 * Standalone chapter scripting (the script route). Cancel rolls the chapter
 * back to scripted/pending; failure marks the chapter + job and fails the run.
 */
export async function scriptChapterWorkflow(
  chapterId: string,
  jobId: string
): Promise<"scripted" | "cancelled" | "failed"> {
  "use workflow";
  const result = await runScriptPhase(chapterId, jobId);
  if (result.outcome === "scripted") {
    await completeJobStep(jobId);
  }
  if (result.outcome === "failed") {
    throw new Error(result.error ?? "Scripting failed"); // run shows failed
  }
  return result.outcome;
}
