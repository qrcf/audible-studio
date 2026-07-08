import { FatalError } from "workflow";
import { ensureBookIntro } from "@/lib/intro";
import {
  completeJob,
  failJob,
  isCancelled,
  setJobProgress,
  setJobTotal,
  withProgressPulse,
} from "@/lib/jobs";

/**
 * Build the book's standalone intro section as a tracked job — themed music bed
 * + the narrator reading "{Title}, by {Author}." The heavy lifting is the
 * idempotent, content-addressed `ensureBookIntro`; this step just wraps it with
 * progress so it behaves like a chapter render (visible bar, survives refresh,
 * reconcilable). `force` regenerates so an edited title/author or recast
 * narrator is picked up.
 */
export async function composeIntro(
  bookId: string,
  jobId: string
): Promise<{ cancelled: boolean }> {
  "use step";
  if (await isCancelled(jobId)) return { cancelled: true };
  // Two coarse units (compose → finalize); the pulse + shimmer carry the wait.
  await setJobTotal(jobId, 2);
  await setJobProgress(jobId, { done: 0, note: "Composing title & music…" });
  const result = await withProgressPulse(
    jobId,
    (s) => `Composing title & music… (${s}s)`,
    () => ensureBookIntro(bookId, true)
  );
  // Narrator uncast — not retryable; surface the same message the old route did.
  if (!result) {
    throw new FatalError("Cast the narrator's voice before generating the intro");
  }
  await setJobProgress(jobId, { done: 2, note: "Finishing…" });
  return { cancelled: false };
}

export async function finishIntro(jobId: string): Promise<void> {
  "use step";
  await completeJob(jobId);
}

/** Intro is independent of book.status, so a failure only marks the job. */
export async function failIntro(jobId: string, message: string): Promise<void> {
  "use step";
  console.error(`Intro generation failed (${jobId}):`, message);
  await failJob(jobId, message);
}
