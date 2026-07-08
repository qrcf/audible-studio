import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const DATA_DIR = path.join(process.cwd(), "data");

function createDb(): BetterSQLite3Database<typeof schema> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new Database(path.join(DATA_DIR, "app.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  recoverInterruptedWork(sqlite);
  return drizzle(sqlite, { schema });
}

// A live job pulses updatedAt at least every ~20s (withHeartbeat in lib/jobs);
// anything quieter than this is orphaned — its process is gone.
const STALE_AFTER_SEC = 120;

/**
 * Runs on every fresh DB connection (i.e. every new server process — Next dev
 * spawns workers lazily and restarts itself on memory pressure, killing
 * in-flight after() work). Jobs whose heartbeat has gone stale are failed and
 * ONLY their books/chapters roll back to the last stable status; jobs alive
 * in sibling processes keep running untouched. The guided pipeline surfaces
 * Retry for the failed ones instead of spinning forever.
 */
function recoverInterruptedWork(sqlite: Database.Database): void {
  const stale = sqlite
    .prepare(
      `SELECT id, book_id AS bookId, chapter_id AS chapterId FROM jobs
       WHERE status = 'running' AND updated_at < (strftime('%s','now') - ${STALE_AFTER_SEC})`
    )
    .all() as { id: string; bookId: string; chapterId: string | null }[];
  if (stale.length === 0) return;
  console.warn(`Recovering ${stale.length} job(s) orphaned by a server restart`);

  const failJob = sqlite.prepare(
    `UPDATE jobs SET status='failed', note=NULL, error='Interrupted by a server restart — retry it'
     WHERE id = ? AND status='running'`
  );
  const rollbackChapter = sqlite.prepare(
    `UPDATE chapters SET status = CASE
        WHEN EXISTS (SELECT 1 FROM segments WHERE segments.chapter_id = chapters.id) THEN 'scripted'
        ELSE 'pending' END
     WHERE id = ? AND status IN ('scripting','generating')`
  );
  // Roll a book back only when no other live job still owns it
  const rollbackBook = sqlite.prepare(
    `UPDATE books SET status = CASE
        WHEN status = 'generating' THEN 'cast'
        WHEN EXISTS (SELECT 1 FROM characters WHERE characters.book_id = books.id) THEN 'analyzed'
        ELSE 'parsed' END
     WHERE id = ? AND status IN ('analyzing','casting','generating')
       AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.book_id = books.id AND jobs.status='running')`
  );

  for (const job of stale) failJob.run(job.id);
  for (const job of stale) {
    if (job.chapterId) rollbackChapter.run(job.chapterId);
  }
  for (const bookId of new Set(stale.map((j) => j.bookId))) rollbackBook.run(bookId);
}

// Reuse one connection across Next.js dev hot reloads
const globalForDb = globalThis as unknown as {
  __audibleDb?: BetterSQLite3Database<typeof schema>;
};

export const db = globalForDb.__audibleDb ?? (globalForDb.__audibleDb = createDb());

export * from "./schema";
