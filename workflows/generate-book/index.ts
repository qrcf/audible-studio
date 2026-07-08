import { createHook, getWorkflowMetadata } from "workflow";
import { beginChapter, finishBook, listPending, type PendingChapter } from "./steps";

interface ChapterOutcome {
  outcome: "ready" | "cancelled" | "failed";
}

/**
 * Whole-book generation. Chapters are statically partitioned into
 * ELEVEN_CONCURRENCY lanes (a shared mutable counter would diverge on replay);
 * each lane runs its chapters sequentially as child runs and waits on a hook.
 * Because TTS is strictly sequential within a chapter, concurrent lanes ≈
 * concurrent ElevenLabs requests — which IS the account concurrency cap.
 */
export async function generateBookWorkflow(
  bookId: string,
  concurrency: number
): Promise<void> {
  "use workflow";
  const pending = await listPending(bookId);
  if (pending.length === 0) {
    await finishBook(bookId);
    return;
  }

  const laneCount = Math.max(1, Math.min(concurrency, pending.length));
  const runId = getWorkflowMetadata().workflowRunId;
  // Shared flag: once any lane sees a cancel, the others stop after their
  // current chapter (matches the old worker-pool `cancelled` behaviour).
  const state = { cancelled: false };

  const lanes: Promise<void>[] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    const chapters = pending.filter((_, idx) => idx % laneCount === lane);
    lanes.push(runLane(bookId, runId, chapters, state));
  }
  await Promise.all(lanes);
  await finishBook(bookId);
}

async function runLane(
  bookId: string,
  runId: string,
  chapters: PendingChapter[],
  state: { cancelled: boolean }
): Promise<void> {
  for (const ch of chapters) {
    if (state.cancelled) return;
    const token = `ch:${runId}:${ch.id}`;
    const hook = createHook<ChapterOutcome>({ token });
    await beginChapter(bookId, ch.id, ch.needsScript, token);
    const result = await hook; // suspends with zero polling until the child reports
    if (result.outcome === "cancelled") state.cancelled = true;
  }
}
