import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, chapters, segments } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { createJob, withHeartbeat } from "@/lib/jobs";
import { generateChapter, getAssignmentResolver } from "@/lib/generation";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ELEVENLABS_API_KEY");
    const chapter = db.select().from(chapters).where(eq(chapters.id, id)).get();
    if (!chapter) throw new AppError("Chapter not found", "not_found", 404);
    if (chapter.status === "generating" || chapter.status === "scripting") {
      throw new AppError("Chapter is busy", "busy", 409);
    }

    const segs = db
      .select({ characterId: segments.characterId, kind: segments.kind })
      .from(segments)
      .where(eq(segments.chapterId, id))
      .all();
    if (segs.length === 0) {
      throw new AppError("Script this chapter first", "not_scripted");
    }
    const missing = getAssignmentResolver(chapter.bookId).missingNames(
      segs.filter((s) => s.kind !== "sfx")
    );
    if (missing.length > 0) {
      throw new AppError(`No voice assigned for: ${missing.join(", ")}. Cast voices first.`, "uncast");
    }

    const jobId = createJob("generate", chapter.bookId, id);
    db.update(chapters).set({ status: "generating", error: null }).where(eq(chapters.id, id)).run();
    after(() => withHeartbeat(jobId, () => generateChapter(id, jobId)));
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
