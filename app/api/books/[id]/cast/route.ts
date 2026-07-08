import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, books, characters } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { createJob } from "@/lib/jobs";
import { runCastingJob } from "@/lib/pipeline";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ANTHROPIC_API_KEY");
    requireEnv("ELEVENLABS_API_KEY");
    const book = db.select().from(books).where(eq(books.id, id)).get();
    if (!book) throw new AppError("Book not found", "not_found", 404);
    if (book.status === "casting") throw new AppError("Casting already running", "busy", 409);
    const hasCharacters =
      db.select({ id: characters.id }).from(characters).where(eq(characters.bookId, id)).limit(1).all()
        .length > 0;
    if (!hasCharacters) throw new AppError("Run character analysis first", "no_characters");

    const jobId = createJob("cast", id);
    db.update(books).set({ status: "casting", error: null }).where(eq(books.id, id)).run();
    after(() => runCastingJob(id, jobId));
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
