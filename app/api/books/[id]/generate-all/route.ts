import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, books, characters } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { generateBookWorkflow } from "@/workflows/generate-book";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ELEVENLABS_API_KEY");
    requireEnv("ANTHROPIC_API_KEY"); // unscripted chapters get scripted on the fly
    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (!book) throw new AppError("Book not found", "not_found", 404);
    if (book.status === "generating") throw new AppError("Generation already running", "busy", 409);

    const hasCast =
      (await db.select({ id: characters.id }).from(characters).where(eq(characters.bookId, id)).limit(1))
        .length > 0;
    if (!hasCast) {
      throw new AppError("Analyze characters and cast voices first", "no_characters");
    }

    // process.env isn't available in the workflow sandbox — pass the cap in
    const concurrency = Math.max(1, Number(process.env.ELEVEN_CONCURRENCY) || 2);
    const run = await start(generateBookWorkflow, [id, concurrency]);
    await db.update(books).set({ activeRunId: run.runId }).where(eq(books.id, id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
