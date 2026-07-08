import {
  analyzeChunk,
  failAnalyze,
  finishAnalyze,
  mergeCast,
  prepareAnalysis,
  reconcile,
  unwindAnalyzeCancelled,
} from "./steps";

// Matches the old in-process pool: chunk extractions run 3 at a time.
const WAVE = 3;

/**
 * Character analysis: map (chunk extractions, in waves of three) → reduce
 * (one merge call) → reconcile transaction → stage advance.
 */
export async function analyzeWorkflow(bookId: string, jobId: string): Promise<void> {
  "use workflow";
  try {
    const { chunkCount } = await prepareAnalysis(bookId, jobId);

    const extractions = [];
    for (let w = 0; w < chunkCount; w += WAVE) {
      const wave = [];
      for (let i = w; i < Math.min(w + WAVE, chunkCount); i++) {
        wave.push(analyzeChunk(bookId, jobId, i, chunkCount));
      }
      const results = await Promise.all(wave);
      if (results.some((r) => r.cancelled)) {
        await unwindAnalyzeCancelled(bookId);
        return;
      }
      for (const r of results) {
        if (r.extraction) extractions.push(r.extraction);
      }
    }

    const merge = await mergeCast(bookId, jobId, extractions);
    if (merge.cancelled || !merge.merged) {
      await unwindAnalyzeCancelled(bookId);
      return;
    }

    await reconcile(bookId, merge.merged);
    await finishAnalyze(bookId, jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failAnalyze(bookId, jobId, message);
    throw err; // run shows failed in observability
  }
}
