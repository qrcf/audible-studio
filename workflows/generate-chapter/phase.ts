import {
  failChapter,
  finalizeChapter,
  prepareChapter,
  renderBatch,
  unwindChapterCancelled,
  type StitchChain,
} from "./steps";

export interface GeneratePhaseResult {
  outcome: "ready" | "cancelled" | "failed";
  error?: string;
}

/**
 * Orchestrates one chapter's audio rendering: time-budgeted sequential render
 * batches (the v2 stitch chain rides between them), then the concat/finalize
 * step. Runs inside a workflow body; marks its own failure/cancel state so
 * callers just branch on the outcome.
 */
export async function runGenerateChapterPhase(
  chapterId: string,
  jobId: string
): Promise<GeneratePhaseResult> {
  let bookId = "";
  try {
    const prep = await prepareChapter(chapterId, jobId);
    bookId = prep.bookId;

    let nextIdx = 0;
    let chain: StitchChain | null = null;
    let charsUsed = 0;
    while (nextIdx < prep.total) {
      const out = await renderBatch(chapterId, jobId, nextIdx, chain, charsUsed);
      if (out.cancelled) {
        await unwindChapterCancelled(chapterId, bookId);
        return { outcome: "cancelled" };
      }
      nextIdx = out.nextIdx;
      chain = out.chain;
      charsUsed = out.charsUsed;
    }

    await finalizeChapter(chapterId, jobId);
    return { outcome: "ready" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failChapter(chapterId, bookId, jobId, message);
    return { outcome: "failed", error: message };
  }
}
