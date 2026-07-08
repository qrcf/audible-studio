import { runScriptPhase } from "./phase";
import { completeJobStep, pingDispatch } from "../shared/steps";

/**
 * Standalone chapter scripting (the script route + the script queue). Cancel
 * rolls the chapter back to scripted/pending; failure marks the chapter + job
 * and fails the run. `appUrl`/`secret` let the terminal step ping the dispatcher
 * so the next queued job starts server-side without a book page open.
 */
export async function scriptChapterWorkflow(
  chapterId: string,
  jobId: string,
  appUrl: string = "",
  secret: string = ""
): Promise<"scripted" | "cancelled" | "failed"> {
  "use workflow";
  const result = await runScriptPhase(chapterId, jobId);
  if (result.outcome === "scripted") {
    await completeJobStep(jobId);
  }
  await pingDispatch(appUrl, secret);
  if (result.outcome === "failed") {
    throw new Error(result.error ?? "Scripting failed"); // run shows failed
  }
  return result.outcome;
}
