import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, jobs } from "@/lib/db";
import type { JobStatus } from "@/lib/db/schema";
import { JobCancelledError } from "@/lib/errors";

export function createJob(
  type: "analyze" | "cast" | "script" | "generate",
  bookId: string,
  chapterId?: string
): string {
  const id = randomUUID();
  db.insert(jobs).values({ id, type, bookId, chapterId: chapterId ?? null }).run();
  return id;
}

export function setJobTotal(id: string, total: number): void {
  db.update(jobs).set({ total, updatedAt: new Date() }).where(eq(jobs.id, id)).run();
}

export function tickJob(id: string, opts: { chars?: number; note?: string } = {}): void {
  db.update(jobs)
    .set({
      done: sql`${jobs.done} + 1`,
      charsUsed: sql`${jobs.charsUsed} + ${opts.chars ?? 0}`,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, id))
    .run();
}

export function noteJob(id: string, note: string): void {
  db.update(jobs).set({ note, updatedAt: new Date() }).where(eq(jobs.id, id)).run();
}

// Terminal transitions only apply to running jobs so a cancellation that
// lands first isn't overwritten by the worker's own complete/fail.
export function completeJob(id: string): void {
  db.update(jobs)
    .set({ status: "completed", note: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .run();
}

export function failJob(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  db.update(jobs)
    .set({ status: "failed", error: message, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .run();
}

export function cancelJob(id: string): boolean {
  const result = db
    .update(jobs)
    .set({ status: "cancelled", note: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
    .run();
  return result.changes > 0;
}

/** Cancel every running job for a book; returns how many were cancelled. */
export function cancelBookJobs(bookId: string): number {
  const result = db
    .update(jobs)
    .set({ status: "cancelled", note: null, updatedAt: new Date() })
    .where(and(eq(jobs.bookId, bookId), eq(jobs.status, "running")))
    .run();
  return result.changes;
}

export function jobStatus(id: string): JobStatus | undefined {
  return db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).get()?.status;
}

/** Workers call this between units of work to honour cancellation quickly. */
export function assertNotCancelled(id: string): void {
  if (jobStatus(id) === "cancelled") throw new JobCancelledError();
}

/**
 * Pulse updatedAt while `fn` runs so crash recovery (lib/db) can tell a live
 * job in a sibling Next.js worker process from one orphaned by a dead process
 * — long LLM calls otherwise leave no sign of life for minutes.
 */
export async function withHeartbeat<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    try {
      db.update(jobs)
        .set({ updatedAt: new Date() })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
        .run();
    } catch {
      // DB hiccups shouldn't kill the work; the next pulse retries
    }
  }, 20_000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
