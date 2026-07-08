import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, books } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { createJob } from "@/lib/jobs";
import { runAnalysisStage } from "@/lib/pipeline";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ANTHROPIC_API_KEY");
    const book = db.select().from(books).where(eq(books.id, id)).get();
    if (!book) throw new AppError("Book not found", "not_found", 404);
    if (book.status === "analyzing") throw new AppError("Analysis already running", "busy", 409);

    const jobId = createJob("analyze", id);
    db.update(books).set({ status: "analyzing", error: null }).where(eq(books.id, id)).run();
    // Stage variant so a manual retry also advances an armed pipeline (no-op otherwise)
    after(() => runAnalysisStage(id, jobId));
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
