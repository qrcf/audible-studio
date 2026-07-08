import { eq } from "drizzle-orm";
import { db, books, characters } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { cancelBookJobs } from "@/lib/jobs";

/**
 * Cancel everything in flight for a book: running jobs flip to "cancelled"
 * (workers notice between chunks/segments and unwind statuses themselves),
 * and the guided pipeline closes. Also resets book status defensively in
 * case a worker died without unwinding (e.g. dev-server restart).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const book = db.select().from(books).where(eq(books.id, id)).get();
    if (!book) throw new AppError("Book not found", "not_found", 404);

    const cancelled = cancelBookJobs(id);
    db.update(books).set({ pipelineStage: null }).where(eq(books.id, id)).run();

    if (book.status === "analyzing" || book.status === "casting") {
      const hasCharacters =
        db.select({ id: characters.id }).from(characters).where(eq(characters.bookId, id)).limit(1).all()
          .length > 0;
      db.update(books)
        .set({ status: hasCharacters ? "analyzed" : "parsed", error: null })
        .where(eq(books.id, id))
        .run();
    }

    return Response.json({ cancelled });
  } catch (err) {
    return errorResponse(err);
  }
}
