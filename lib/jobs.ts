import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getRun } from "workflow/api";
import { getDb, jobs } from "@/lib/db";
import type { JobStatus } from "@/lib/db/schema";
import { JobCancelledError } from "@/lib/errors";

export type JobType = "analyze" | "cast" | "script" | "generate" | "intro";

export async function createJob(
  type: JobType,
  bookId: string,
  chapterId?: string
): Promise<string> {
  const id = randomUUID();
  await getDb().insert(jobs).values({ id, type, bookId, chapterId: chapterId ?? null });
  return id;
}

/**
 * Enqueue a job for the bounded dispatcher (lib/queue.ts) to start later.
 * Inserted as "queued" (vs createJob's immediate "running"); `scriptFirst`
 * asks the generate workflow to script the chapter first when it has no script.
 */
export async function enqueueJob(
  type: JobType,
  bookId: string,
  chapterId: string,
  opts: { scriptFirst?: boolean } = {}
): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(jobs)
    .values({ id, type, bookId, chapterId, status: "queued", scriptFirst: opts.scriptFirst ?? false });
  return id;
}

/** Record which workflow run is executing this job (cancel backstop + reconciler). */
export async function attachRunId(jobId: string, runId: string): Promise<void> {
  await getDb().update(jobs).set({ runId, updatedAt: new Date() }).where(eq(jobs.id, jobId));
}

export async function setJobTotal(id: string, total: number): Promise<void> {
  await getDb().update(jobs).set({ total, updatedAt: new Date() }).where(eq(jobs.id, id));
}

/**
 * ABSOLUTE progress write, monotone via GREATEST — workflow steps retry after
 * failures and must be able to re-report the same numbers without
 * double-counting (which the old incremental tick could not survive).
 */
export async function setJobProgress(
  id: string,
  progress: { done?: number; charsUsed?: number; note?: string }
): Promise<void> {
  await getDb()
    .update(jobs)
    .set({
      ...(progress.done !== undefined
        ? { done: sql`GREATEST(${jobs.done}, ${progress.done})` }
        : {}),
      ...(progress.charsUsed !== undefined
        ? { charsUsed: sql`GREATEST(${jobs.charsUsed}, ${progress.charsUsed})` }
        : {}),
      ...(progress.note !== undefined ? { note: progress.note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id));
}

export async function noteJob(id: string, note: string): Promise<void> {
  await getDb().update(jobs).set({ note, updatedAt: new Date() }).where(eq(jobs.id, id));
}

/**
 * Run `fn` while pulsing an elapsed-time note every few seconds. For single
 * long LLM calls (e.g. the cast merge) this keeps the UI visibly alive and
 * keeps updatedAt fresh so the stale-job reconciler never mistakes a slow
 * step for a dead one. `label(elapsedSec)` builds the note text.
 */
export async function withProgressPulse<T>(
  jobId: string,
  label: (elapsedSec: number) => string,
  fn: () => Promise<T>,
  intervalMs = 5000
): Promise<T> {
  const startedAt = Date.now();
  await noteJob(jobId, label(0));
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    noteJob(jobId, label(elapsed)).catch(() => {
      // a dropped pulse is harmless; the next one retries
    });
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// Terminal transitions only apply to running jobs so a cancellation that
// lands first isn't overwritten by the worker's own complete/fail.
export async function completeJob(id: string): Promise<void> {
  await getDb()
    .update(jobs)
    .set({ status: "completed", note: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")));
}

export async function failJob(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await getDb()
    .update(jobs)
    .set({ status: "failed", error: message, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")));
}

// Queued jobs can be cancelled too (they simply never start); running jobs
// flip and their workflow observes the flag at the next safe point.
export async function cancelJob(id: string): Promise<boolean> {
  const cancelled = await getDb()
    .update(jobs)
    .set({ status: "cancelled", note: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), inArray(jobs.status, ["running", "queued"])))
    .returning({ id: jobs.id });
  return cancelled.length > 0;
}

/** Cancel every running or queued job for a book; returns how many were cancelled. */
export async function cancelBookJobs(bookId: string): Promise<number> {
  const cancelled = await getDb()
    .update(jobs)
    .set({ status: "cancelled", note: null, updatedAt: new Date() })
    .where(and(eq(jobs.bookId, bookId), inArray(jobs.status, ["running", "queued"])))
    .returning({ id: jobs.id });
  return cancelled.length;
}

export async function jobStatus(id: string): Promise<JobStatus | undefined> {
  const rows = await getDb()
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1);
  return rows[0]?.status;
}

export async function isCancelled(id: string): Promise<boolean> {
  return (await jobStatus(id)) === "cancelled";
}

/** Workers call this between units of work to honour cancellation quickly. */
export async function assertNotCancelled(id: string): Promise<void> {
  if (await isCancelled(id)) throw new JobCancelledError();
}

// Steps refresh updatedAt on every progress write, so a "running" job that has
// been silent this long either lost its workflow run entirely (RUNTIME_ERROR,
// deleted deployment) or is stuck in a long retry backoff.
const STALE_AFTER_MS = 90_000;

/**
 * Fail any zombie jobs whose workflow run is no longer running, then roll
 * their book/chapter back to the last stable status. Replaces the old
 * boot-time recoverInterruptedWork; called from the (2s-polled) progress
 * route, so it costs nothing until something actually looks stale.
 */
export async function reconcileStaleJobs(bookId: string): Promise<number> {
  const db = getDb();
  const stale = await db
    .select({ id: jobs.id, chapterId: jobs.chapterId, runId: jobs.runId })
    .from(jobs)
    .where(
      and(
        eq(jobs.bookId, bookId),
        eq(jobs.status, "running"),
        lt(jobs.updatedAt, new Date(Date.now() - STALE_AFTER_MS))
      )
    );
  if (stale.length === 0) return 0;

  let recovered = 0;
  for (const job of stale) {
    let dead = !job.runId; // pre-workflow rows have no run to be alive in
    if (job.runId) {
      try {
        const status = await getRun(job.runId).status;
        dead = status !== "running" && status !== "pending";
      } catch {
        dead = true; // run unknown to the backend — treat as gone
      }
    }
    if (!dead) continue;
    recovered++;

    await db
      .update(jobs)
      .set({
        status: "failed",
        note: null,
        error: "Interrupted — retry it",
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));

    if (job.chapterId) {
      await db.execute(sql`
        UPDATE chapters SET status = CASE
            WHEN EXISTS (SELECT 1 FROM segments WHERE segments.chapter_id = chapters.id) THEN 'scripted'
            ELSE 'pending' END
        WHERE id = ${job.chapterId} AND status IN ('scripting','generating')`);
    }
  }

  if (recovered > 0) {
    // Roll the book back only when no live job still owns it
    await db.execute(sql`
      UPDATE books SET status = CASE
          WHEN status = 'generating' THEN 'cast'
          WHEN EXISTS (SELECT 1 FROM characters WHERE characters.book_id = books.id) THEN 'analyzed'
          ELSE 'parsed' END
      WHERE id = ${bookId} AND status IN ('analyzing','casting','generating')
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.book_id = books.id AND jobs.status = 'running')`);
  }
  return recovered;
}
