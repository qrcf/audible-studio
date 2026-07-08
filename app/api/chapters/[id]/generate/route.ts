import { and, eq, inArray } from "drizzle-orm";
import { getDb, chapters, jobs, segments } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { enqueueJob } from "@/lib/jobs";
import { getAssignmentResolver, refreshBookStatus } from "@/lib/generation";
import { dispatchAll } from "@/lib/queue";

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
    // A queued generate job (chapter still reads "scripted") already covers this.
    const dup = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.chapterId, id), eq(jobs.type, "generate"), inArray(jobs.status, ["queued", "running"]))
      )
      .limit(1);
    if (dup.length > 0) throw new AppError("Chapter is already queued", "busy", 409);

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

    // Enqueue and let the bounded dispatcher start it when a slot is free.
    const jobId = await enqueueJob("generate", chapter.bookId, id);
    await dispatchAll();
    await refreshBookStatus(chapter.bookId);
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
