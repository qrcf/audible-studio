import { eq, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, books, chapters } from "@/lib/db";
import { attachRunId, failJob } from "@/lib/jobs";
import { generateChapterWorkflow } from "@/workflows/generate-chapter";
import { scriptChapterWorkflow } from "@/workflows/script-chapter";

/**
 * Bounded work queue for the two chapter-level operations. Jobs are inserted as
 * "queued" (lib/jobs.enqueueJob) and this dispatcher promotes them to "running"
 * — never more than the per-type cap concurrently — and starts their workflow.
 *
 * Concurrency is GLOBAL (across books): the ElevenLabs cap is account-wide, so a
 * single shared budget is the honest constraint. Scripting gets its own, looser
 * cap so you can script chapters in parallel while audio generation drains.
 *
 * Dispatch is triggered from three places so the queue advances even with no UI
 * open: the enqueue routes (immediate fill), each workflow's completion ping to
 * /api/internal/dispatch (server-side, tab-independent — this is what lets you
 * walk away), and the 2s progress poll as a self-healing backstop.
 */
export type QueueType = "generate" | "script";

function cap(type: QueueType): number {
  if (type === "generate") return Math.max(1, Number(process.env.ELEVEN_CONCURRENCY) || 2);
  return Math.max(1, Number(process.env.SCRIPT_CONCURRENCY) || 3);
}

/** Passed into the workflow so its completion step can ping dispatch (process.env
 * is unreliable inside the workflow sandbox, so values are threaded as args). */
function pingArgs(): [string, string] {
  return [process.env.APP_URL ?? "", process.env.DISPATCH_SECRET ?? ""];
}

interface Claim {
  id: string;
  chapterId: string | null;
  bookId: string;
  scriptFirst: boolean;
}

/**
 * Atomically claim up to (cap − running) queued jobs of one type, oldest first.
 * A per-type transaction-scoped advisory lock serializes concurrent dispatchers
 * so the count→claim window can't overshoot the cap; SKIP LOCKED keeps two
 * callers from fighting over the same rows.
 */
async function claim(type: QueueType): Promise<Claim[]> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch:" + type}))`);
    const runningRes = await tx.execute(
      sql`SELECT count(*)::int AS n FROM jobs WHERE type = ${type} AND status = 'running'`
    );
    const running = Number((runningRes.rows[0] as { n: number }).n) || 0;
    const slots = cap(type) - running;
    if (slots <= 0) return [];
    const claimed = await tx.execute(sql`
      UPDATE jobs SET status = 'running', updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
        WHERE type = ${type} AND status = 'queued'
        ORDER BY created_at ASC
        LIMIT ${slots}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, chapter_id AS "chapterId", book_id AS "bookId", script_first AS "scriptFirst"`);
    return claimed.rows as unknown as Claim[];
  });
}

async function rollbackClaim(chapterId: string, message: string): Promise<void> {
  // A chapter with a script rolls back to "scripted"; otherwise it never started.
  await getDb().execute(sql`
    UPDATE chapters SET status = CASE
        WHEN EXISTS (SELECT 1 FROM segments WHERE segments.chapter_id = ${chapterId}) THEN 'scripted'
        ELSE 'pending' END,
      error = ${message}
    WHERE id = ${chapterId}`);
}

async function dispatch(type: QueueType): Promise<void> {
  const claims = await claim(type);
  const db = getDb();
  for (const c of claims) {
    if (!c.chapterId) {
      await failJob(c.id, "Queued job has no chapter");
      continue;
    }
    const chapterId = c.chapterId;
    try {
      // Reflect the live state immediately (the workflow's own steps re-assert it).
      const nextStatus = type === "script" || c.scriptFirst ? "scripting" : "generating";
      await db.update(chapters).set({ status: nextStatus, error: null }).where(eq(chapters.id, chapterId));
      if (type === "generate") {
        await db.update(books).set({ status: "generating" }).where(eq(books.id, c.bookId));
      }
      const run =
        type === "generate"
          ? await start(generateChapterWorkflow, [chapterId, c.id, Boolean(c.scriptFirst), ...pingArgs()])
          : await start(scriptChapterWorkflow, [chapterId, c.id, ...pingArgs()]);
      await attachRunId(c.id, run.runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(c.id, message);
      await rollbackClaim(chapterId, message);
    }
  }
}

/** Fill open slots for both pools. Cheap no-op when nothing is queued. */
export async function dispatchAll(): Promise<void> {
  await dispatch("script");
  await dispatch("generate");
}
