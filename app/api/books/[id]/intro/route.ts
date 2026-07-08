import { and, eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, books, jobs } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { attachRunId, createJob } from "@/lib/jobs";
import { introWorkflow } from "@/workflows/intro";

/**
 * (Re)generate the book's standalone intro section — themed music bed + the
 * narrator reading "{Title}, by {Author}." Dispatched as a durable, tracked job
 * (like casting/chapter generation) so it shows real progress and survives a
 * refresh. Regenerates from scratch so it picks up an edited title/author or a
 * recast narrator.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const [book] = await db.select({ id: books.id }).from(books).where(eq(books.id, id)).limit(1);
    if (!book) throw new AppError("Book not found", "not_found", 404);

    const [running] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.bookId, id), eq(jobs.type, "intro"), eq(jobs.status, "running")))
      .limit(1);
    if (running) throw new AppError("Intro is already generating", "busy", 409);

    const jobId = await createJob("intro", id);
    const run = await start(introWorkflow, [id, jobId]);
    await attachRunId(jobId, run.runId);
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
