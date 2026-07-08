import { asc, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, books, chapters, segments } from "@/lib/db";
import { createJob } from "@/lib/jobs";
import { refreshBookStatus } from "@/lib/generation";
import { chapterPipelineWorkflow } from "./chapter-pipeline";

export interface PendingChapter {
  id: string;
  needsScript: boolean;
}

/** Non-ready chapters in order; marks the book generating. */
export async function listPending(bookId: string): Promise<PendingChapter[]> {
  "use step";
  const db = getDb();
  const rows = await db
    .select({ id: chapters.id, status: chapters.status })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.idx));
  const pending = rows.filter((c) => c.status !== "ready");

  const withScript = new Set(
    (
      await db
        .select({ chapterId: segments.chapterId })
        .from(segments)
        .innerJoin(chapters, eq(segments.chapterId, chapters.id))
        .where(eq(chapters.bookId, bookId))
    ).map((s) => s.chapterId)
  );

  await db.update(books).set({ status: "generating" }).where(eq(books.id, bookId));
  return pending.map((c) => ({
    id: c.id,
    needsScript: !withScript.has(c.id) || c.status === "pending",
  }));
}

/** Create the chapter's generate job and start its child pipeline run. */
export async function beginChapter(
  bookId: string,
  chapterId: string,
  needsScript: boolean,
  hookToken: string
): Promise<{ jobId: string }> {
  "use step";
  const jobId = await createJob("generate", bookId, chapterId);
  await start(chapterPipelineWorkflow, [chapterId, jobId, hookToken, needsScript]);
  return { jobId };
}

export async function finishBook(bookId: string): Promise<void> {
  "use step";
  await refreshBookStatus(bookId);
}
