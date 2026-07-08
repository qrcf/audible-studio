import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, books, characters } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { generateBook } from "@/lib/generation";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ELEVENLABS_API_KEY");
    requireEnv("ANTHROPIC_API_KEY"); // unscripted chapters get scripted on the fly
    const book = db.select().from(books).where(eq(books.id, id)).get();
    if (!book) throw new AppError("Book not found", "not_found", 404);
    if (book.status === "generating") throw new AppError("Generation already running", "busy", 409);

    const hasCast =
      db.select({ id: characters.id }).from(characters).where(eq(characters.bookId, id)).limit(1).all()
        .length > 0;
    if (!hasCast) {
      throw new AppError("Analyze characters and cast voices first", "no_characters");
    }

    after(() => generateBook(id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
