import { asc, desc, eq } from "drizzle-orm";
import { getDb, books, chapters, jobs } from "@/lib/db";
import { reconcileStaleJobs } from "@/lib/jobs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  // Fail zombie jobs whose workflow run has died (replaces boot-time recovery)
  await reconcileStaleJobs(id);
  const [book] = await db
    .select({
      id: books.id,
      status: books.status,
      pipelineStage: books.pipelineStage,
      error: books.error,
    })
    .from(books)
    .where(eq(books.id, id))
    .limit(1);
  if (!book) return Response.json({ error: "Not found" }, { status: 404 });

  const chapterRows = await db
    .select({
      id: chapters.id,
      idx: chapters.idx,
      status: chapters.status,
      durationSec: chapters.durationSec,
      audioPath: chapters.audioPath,
      error: chapters.error,
    })
    .from(chapters)
    .where(eq(chapters.bookId, id))
    .orderBy(asc(chapters.idx));

  const jobRows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.bookId, id))
    .orderBy(desc(jobs.createdAt))
    .limit(25);

  return Response.json({ book, chapters: chapterRows, jobs: jobRows });
}
