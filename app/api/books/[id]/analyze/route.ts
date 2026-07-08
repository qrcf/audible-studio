import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, books } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { attachRunId, createJob } from "@/lib/jobs";
import { analyzeWorkflow } from "@/workflows/analyze";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ANTHROPIC_API_KEY");
    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (!book) throw new AppError("Book not found", "not_found", 404);
    if (book.status === "analyzing") throw new AppError("Analysis already running", "busy", 409);

    const jobId = await createJob("analyze", id);
    await db.update(books).set({ status: "analyzing", error: null }).where(eq(books.id, id));
    const run = await start(analyzeWorkflow, [id, jobId]);
    await attachRunId(jobId, run.runId);
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
