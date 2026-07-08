import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, chapters, segments } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { attachRunId, createJob } from "@/lib/jobs";
import { getAssignmentResolver } from "@/lib/generation";
import { generateChapterWorkflow } from "@/workflows/generate-chapter";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ELEVENLABS_API_KEY");
    const db = getDb();
    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
    if (!chapter) throw new AppError("Chapter not found", "not_found", 404);
    if (chapter.status === "generating" || chapter.status === "scripting") {
      throw new AppError("Chapter is busy", "busy", 409);
    }

    const segs = await db
      .select({ characterId: segments.characterId, kind: segments.kind })
      .from(segments)
      .where(eq(segments.chapterId, id));
    if (segs.length === 0) {
      throw new AppError("Script this chapter first", "not_scripted");
    }
    const { missingNames } = await getAssignmentResolver(chapter.bookId);
    const missing = missingNames(segs.filter((s) => s.kind !== "sfx"));
    if (missing.length > 0) {
      throw new AppError(`No voice assigned for: ${missing.join(", ")}. Cast voices first.`, "uncast");
    }

    const jobId = await createJob("generate", chapter.bookId, id);
    await db.update(chapters).set({ status: "generating", error: null }).where(eq(chapters.id, id));
    const run = await start(generateChapterWorkflow, [id, jobId]);
    await attachRunId(jobId, run.runId);
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
