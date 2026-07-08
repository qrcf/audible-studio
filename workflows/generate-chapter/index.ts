import { runGenerateChapterPhase } from "./phase";
import { runScriptPhase } from "../script-chapter/phase";
import { checkJobCancelled, markChapterScripting } from "../script-chapter/steps";
import { chapterHasScript, failJobStep, noteJobStep, pingDispatch } from "../shared/steps";

export type ChapterOutcome = "ready" | "cancelled" | "failed";

/**
 * Render one chapter. Started by the queue dispatcher (lib/queue.ts) and the
 * sample pipeline. When `scriptFirst` is set and the chapter has no script yet,
 * it scripts first — the generate-all path enqueues unscripted chapters this
 * way (replacing the old generate-book lane workflow). `appUrl`/`secret` let the
 * terminal step ping the dispatcher so the queue keeps draining with no UI open.
 */
export async function generateChapterWorkflow(
  chapterId: string,
  jobId: string,
  scriptFirst: boolean = false,
  appUrl: string = "",
  secret: string = ""
): Promise<ChapterOutcome> {
  "use workflow";
  const result = await run(chapterId, jobId, scriptFirst);
  await pingDispatch(appUrl, secret);
  if (result.outcome === "failed") {
    throw new Error(result.error ?? "Generation failed"); // run shows failed
  }
  return result.outcome;
}

async function run(
  chapterId: string,
  jobId: string,
  scriptFirst: boolean
): Promise<{ outcome: ChapterOutcome; error?: string }> {
  if (scriptFirst && !(await chapterHasScript(chapterId))) {
    await noteJobStep(jobId, "Scripting chapter…");
    await markChapterScripting(chapterId);
    // No per-chunk progress on the generate job during scripting; cancellation
    // is observed between the phases (parity with the old book worker).
    const s = await runScriptPhase(chapterId, null);
    if (s.outcome === "failed") {
      await failJobStep(jobId, s.error ?? "Scripting failed");
      return { outcome: "failed", error: s.error };
    }
    if (s.outcome === "cancelled" || (await checkJobCancelled(jobId))) {
      // The script landed (chapter is 'scripted'); rendering just doesn't start.
      return { outcome: "cancelled" };
    }
  }
  const g = await runGenerateChapterPhase(chapterId, jobId);
  return { outcome: g.outcome, error: g.error };
}
