import { asc, desc, eq } from "drizzle-orm";
import { db, books, chapters, jobs } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const book = db
    .select({
      id: books.id,
      status: books.status,
      pipelineStage: books.pipelineStage,
      error: books.error,
    })
    .from(books)
    .where(eq(books.id, id))
    .get();
  if (!book) return Response.json({ error: "Not found" }, { status: 404 });

  const chapterRows = db
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
    .orderBy(asc(chapters.idx))
    .all();

  const jobRows = db
    .select()
    .from(jobs)
    .where(eq(jobs.bookId, id))
    .orderBy(desc(jobs.createdAt))
    .limit(25)
    .all();

  return Response.json({ book, chapters: chapterRows, jobs: jobRows });
}
