import { and, eq } from "drizzle-orm";
import { getDb, books } from "@/lib/db";
import {
  castBatchLlm,
  persistAssignments,
  prepareCasting,
  type AlreadyCastEntry,
  type AssignmentRow,
  type CastingPrep,
} from "@/lib/analysis/casting";
import {
  completeJob,
  failJob,
  isCancelled,
  noteJob,
  setJobProgress,
  setJobTotal,
  withProgressPulse,
} from "@/lib/jobs";
import { setStageIf } from "@/lib/pipeline";

export type { AlreadyCastEntry, AssignmentRow };

export async function prepareCast(
  bookId: string,
  jobId: string
): Promise<{ cancelled: boolean; prep: CastingPrep | null }> {
  "use step";
  if (await isCancelled(jobId)) return { cancelled: true, prep: null };
  await noteJob(jobId, "Loading voice catalog…");
  const prep = await prepareCasting(bookId);
  // The bar fills one character at a time; batches advance `done` by their size.
  await setJobTotal(jobId, prep.orderedIds.length);
  if (prep.characterCount > 0) {
    await noteJob(
      jobId,
      `Matching ${prep.characterCount} characters to ${prep.voiceCount} voices…`
    );
  }
  return { cancelled: false, prep };
}

export interface CastBatchStepResult {
  cancelled: boolean;
  rows: AssignmentRow[];
  alreadyCast: AlreadyCastEntry[];
  takenVoiceIds: string[];
}

export async function castBatch(
  bookId: string,
  jobId: string,
  batchIds: string[],
  alreadyCast: AlreadyCastEntry[],
  takenVoiceIds: string[],
  hasVariants: boolean,
  progressNote: string,
  done: number
): Promise<CastBatchStepResult> {
  "use step";
  if (await isCancelled(jobId)) {
    return { cancelled: true, rows: [], alreadyCast, takenVoiceIds };
  }
  // Advance the bar to the start of this batch, then pulse an elapsed-time note
  // so a long agentic batch stays visibly alive and updatedAt keeps the stale
  // reaper away.
  await setJobProgress(jobId, { done, note: progressNote });
  const out = await withProgressPulse(
    jobId,
    (s) => `${progressNote} (${s}s)`,
    () => castBatchLlm(bookId, batchIds, alreadyCast, takenVoiceIds, hasVariants)
  );
  return { cancelled: false, ...out };
}

export async function saveAssignments(
  bookId: string,
  jobId: string,
  toCastIds: string[],
  rows: AssignmentRow[],
  shouldAdvanceStatus: boolean
): Promise<{ cancelled: boolean }> {
  "use step";
  if (await isCancelled(jobId)) return { cancelled: true };
  // All batches done — fill the bar while the final save runs.
  await setJobProgress(jobId, { done: toCastIds.length, note: "Saving assignments…" });
  await persistAssignments(bookId, toCastIds, rows, shouldAdvanceStatus);
  return { cancelled: false };
}

/** completeJob + guided-pipeline stage advance (exact runCastingJob semantics). */
export async function finishCast(bookId: string, jobId: string): Promise<void> {
  "use step";
  await completeJob(jobId);
  await setStageIf(bookId, "casting", "voice_review");
}

export async function unwindCastCancelled(bookId: string): Promise<void> {
  "use step";
  await getDb()
    .update(books)
    .set({ status: "analyzed", error: null })
    .where(and(eq(books.id, bookId), eq(books.status, "casting")));
  await setStageIf(bookId, "casting", null);
}

export async function failCast(bookId: string, jobId: string, message: string): Promise<void> {
  "use step";
  console.error(`Casting failed (${bookId}):`, message);
  await failJob(jobId, message);
  await getDb()
    .update(books)
    .set({ status: "error", error: message })
    .where(eq(books.id, bookId));
}
