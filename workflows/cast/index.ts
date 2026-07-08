import {
  castBatch,
  failCast,
  finishCast,
  prepareCast,
  saveAssignments,
  unwindCastCancelled,
  type AlreadyCastEntry,
  type AssignmentRow,
} from "./steps";

// Strictly sequential batches, majors first — each batch sees prior picks as
// fixed context. Mirrors CAST_BATCH in lib/analysis/casting (sandbox code
// can't import that module).
const BATCH = 8;

/** Voice casting: sequential LLM batches feeding picks forward, then one save. */
export async function castWorkflow(bookId: string, jobId: string): Promise<void> {
  "use workflow";
  try {
    const { cancelled, prep } = await prepareCast(bookId, jobId);
    if (cancelled || !prep) {
      await unwindCastCancelled(bookId);
      return;
    }

    let alreadyCast: AlreadyCastEntry[] = prep.alreadyCast;
    let takenVoiceIds: string[] = [];
    const rows: AssignmentRow[] = [];
    for (let offset = 0; offset < prep.orderedIds.length; offset += BATCH) {
      const batchIds = prep.orderedIds.slice(offset, offset + BATCH);
      const note = `Casting voices ${offset + 1}-${Math.min(offset + BATCH, prep.orderedIds.length)} of ${prep.orderedIds.length}…`;
      const out = await castBatch(
        bookId,
        jobId,
        batchIds,
        alreadyCast,
        takenVoiceIds,
        prep.hasVariants,
        note
      );
      if (out.cancelled) {
        await unwindCastCancelled(bookId);
        return;
      }
      rows.push(...out.rows);
      alreadyCast = out.alreadyCast;
      takenVoiceIds = out.takenVoiceIds;
    }

    const saved = await saveAssignments(
      bookId,
      jobId,
      prep.orderedIds,
      rows,
      prep.shouldAdvanceStatus
    );
    if (saved.cancelled) {
      await unwindCastCancelled(bookId);
      return;
    }
    await finishCast(bookId, jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failCast(bookId, jobId, message);
    throw err; // run shows failed in observability
  }
}
