import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, chapters } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { attachRunId, createJob } from "@/lib/jobs";
import { scriptChapterWorkflow } from "@/workflows/script-chapter";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ANTHROPIC_API_KEY");
    const db = getDb();
    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
    if (!chapter) throw new AppError("Chapter not found", "not_found", 404);
    if (chapter.status === "scripting" || chapter.status === "generating") {
      throw new AppError("Chapter is busy", "busy", 409);
    }

    const jobId = await createJob("script", chapter.bookId, id);
    await db.update(chapters).set({ status: "scripting", error: null }).where(eq(chapters.id, id));
    const run = await start(scriptChapterWorkflow, [id, jobId]);
    await attachRunId(jobId, run.runId);
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
