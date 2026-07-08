import { and, eq, isNotNull } from "drizzle-orm";
import { getRun } from "workflow/api";
import { getDb, books, characters, jobs } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { cancelBookJobs } from "@/lib/jobs";

/**
 * Cancel everything in flight for a book: running jobs flip to "cancelled"
 * (workflow steps notice between chunks/segments and unwind statuses
 * themselves), and the guided pipeline closes. Also cancels the underlying
 * workflow runs as a backstop and resets book status defensively.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (!book) throw new AppError("Book not found", "not_found", 404);

    // Collect the run ids of jobs about to be cancelled (backstop kill below)
    const runIds = (
      await db
        .select({ runId: jobs.runId })
        .from(jobs)
        .where(and(eq(jobs.bookId, id), eq(jobs.status, "running"), isNotNull(jobs.runId)))
    )
      .map((j) => j.runId)
      .filter((r): r is string => r !== null);
    if (book.activeRunId) runIds.push(book.activeRunId);

    const cancelled = await cancelBookJobs(id);
    await db.update(books).set({ pipelineStage: null, activeRunId: null }).where(eq(books.id, id));
    for (const runId of runIds) {
      await getRun(runId).cancel().catch(() => {});
    }

    if (book.status === "analyzing" || book.status === "casting") {
      const hasCharacters =
        (await db.select({ id: characters.id }).from(characters).where(eq(characters.bookId, id)).limit(1))
          .length > 0;
      await db
        .update(books)
        .set({ status: hasCharacters ? "analyzed" : "parsed", error: null })
        .where(eq(books.id, id));
    }

    return Response.json({ cancelled });
  } catch (err) {
    return errorResponse(err);
  }
}
