import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, books, characters } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { attachRunId, createJob } from "@/lib/jobs";
import { castWorkflow } from "@/workflows/cast";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ANTHROPIC_API_KEY");
    requireEnv("ELEVENLABS_API_KEY");
    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (!book) throw new AppError("Book not found", "not_found", 404);
    if (book.status === "casting") throw new AppError("Casting already running", "busy", 409);
    const hasCharacters =
      (await db.select({ id: characters.id }).from(characters).where(eq(characters.bookId, id)).limit(1))
        .length > 0;
    if (!hasCharacters) throw new AppError("Run character analysis first", "no_characters");

    const jobId = await createJob("cast", id);
    await db.update(books).set({ status: "casting", error: null }).where(eq(books.id, id));
    const run = await start(castWorkflow, [id, jobId]);
    await attachRunId(jobId, run.runId);
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
