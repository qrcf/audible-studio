import { runScriptPhase } from "../script-chapter/phase";
import { checkJobCancelled, markChapterScripting } from "../script-chapter/steps";
import { runGenerateChapterPhase } from "../generate-chapter/phase";
import { notifyParent } from "../generate-chapter/steps";
import { failJobStep, noteJobStep } from "../shared/steps";

/**
 * One chapter of a whole-book run: script if needed, then render — all under
 * the chapter's generate job, reporting the outcome to the waiting
 * generate-book parent through its hook.
 */
export async function chapterPipelineWorkflow(
  chapterId: string,
  jobId: string,
  hookToken: string,
  needsScript: boolean
): Promise<"ready" | "cancelled" | "failed"> {
  "use workflow";
  if (needsScript) {
    await noteJobStep(jobId, "Scripting chapter…");
    await markChapterScripting(chapterId);
    // No per-chunk progress on the generate job during scripting (parity with
    // the old book worker); cancellation is observed between the phases.
    const s = await runScriptPhase(chapterId, null);
    if (s.outcome === "failed") {
      await failJobStep(jobId, s.error ?? "Scripting failed");
      await notifyParent(hookToken, "failed");
      return "failed";
    }
    if (s.outcome === "cancelled" || (await checkJobCancelled(jobId))) {
      // The script landed (chapter is 'scripted'); rendering just doesn't start
      await notifyParent(hookToken, "cancelled");
      return "cancelled";
    }
  }
  const g = await runGenerateChapterPhase(chapterId, jobId);
  await notifyParent(hookToken, g.outcome);
  return g.outcome;
}
