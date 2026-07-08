import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { getDb, books, characters } from "@/lib/db";
import {
  analyzeChunkLlm,
  loadAnalysisContext,
  mergeCastLlm,
  reconcileCast,
  type ChunkExtraction,
  type MergedCast,
} from "@/lib/analysis/characters";
import {
  completeJob,
  failJob,
  isCancelled,
  setJobProgress,
  setJobTotal,
  withProgressPulse,
} from "@/lib/jobs";
import { setStageIf } from "@/lib/pipeline";

export async function prepareAnalysis(
  bookId: string,
  jobId: string
): Promise<{ chunkCount: number }> {
  "use step";
  const { chunks } = await loadAnalysisContext(bookId);
  await setJobTotal(jobId, chunks.length + 1);
  return { chunkCount: chunks.length };
}

export interface AnalyzeChunkResult {
  cancelled: boolean;
  extraction: ChunkExtraction | null;
}

export async function analyzeChunk(
  bookId: string,
  jobId: string,
  i: number,
  chunkCount: number
): Promise<AnalyzeChunkResult> {
  "use step";
  if (await isCancelled(jobId)) return { cancelled: true, extraction: null };
  const { book, chunks } = await loadAnalysisContext(bookId);
  const extraction = await analyzeChunkLlm(book, chunks, i);
  // Monotone (GREATEST) progress — parallel chunk steps land out of order
  await setJobProgress(jobId, {
    done: i + 1,
    note: `Reading section ${i + 1}/${chunkCount}`,
  });
  return { cancelled: false, extraction };
}

export interface MergeResult {
  cancelled: boolean;
  merged: MergedCast | null;
}

export async function mergeCast(
  bookId: string,
  jobId: string,
  chunkResults: ChunkExtraction[]
): Promise<MergeResult> {
  "use step";
  if (await isCancelled(jobId)) return { cancelled: true, merged: null };
  const { book, fullTextLength } = await loadAnalysisContext(bookId);
  // One large LLM call over every chunk extraction — can run for minutes on a
  // big book, so pulse an elapsed timer to show it's alive and keep the job
  // heartbeat fresh for the reconciler.
  const merged = await withProgressPulse(
    jobId,
    (s) => `Merging cast list from ${chunkResults.length} sections… (${s}s)`,
    () => mergeCastLlm(book, chunkResults, fullTextLength)
  );
  await setJobProgress(jobId, { note: `Found ${merged.characters.length} characters` });
  return { cancelled: false, merged };
}

export async function reconcile(bookId: string, merged: MergedCast): Promise<void> {
  "use step";
  const { openingText } = await loadAnalysisContext(bookId);
  await reconcileCast(bookId, merged, openingText);
}

/** completeJob + guided-pipeline stage advance (exact runAnalysisStage semantics). */
export async function finishAnalyze(bookId: string, jobId: string): Promise<void> {
  "use step";
  await completeJob(jobId);
  const [book] = await getDb()
    .select({ status: books.status })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  if (!book) throw new FatalError("Book not found");
  if (book.status === "analyzed") {
    await setStageIf(bookId, "analyzing", "cast_review");
  }
}

export async function unwindAnalyzeCancelled(bookId: string): Promise<void> {
  "use step";
  const db = getDb();
  const existing = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .limit(1);
  await db
    .update(books)
    .set({ status: existing.length > 0 ? "analyzed" : "parsed", error: null })
    .where(eq(books.id, bookId));
  await setStageIf(bookId, "analyzing", null);
}

export async function failAnalyze(bookId: string, jobId: string, message: string): Promise<void> {
  "use step";
  console.error("Analysis failed:", message);
  await failJob(jobId, message);
  await getDb()
    .update(books)
    .set({ status: "error", error: message })
    .where(eq(books.id, bookId));
}
