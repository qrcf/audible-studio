import { and, eq, inArray } from "drizzle-orm";
import { getDb, chapters, jobs } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { enqueueJob } from "@/lib/jobs";
import { dispatchAll } from "@/lib/queue";

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
    const dup = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.chapterId, id), eq(jobs.type, "script"), inArray(jobs.status, ["queued", "running"]))
      )
      .limit(1);
    if (dup.length > 0) throw new AppError("Chapter is already queued", "busy", 409);

    // Enqueue into the script pool; a single click starts immediately (under cap).
    const jobId = await enqueueJob("script", chapter.bookId, id);
    await dispatchAll();
    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
