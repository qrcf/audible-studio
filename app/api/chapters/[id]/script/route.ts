import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, chapters } from "@/lib/db";
import { errorResponse, AppError, JobCancelledError, requireEnv } from "@/lib/errors";
import { createJob, completeJob, failJob, withHeartbeat } from "@/lib/jobs";
import { scriptChapter } from "@/lib/analysis/scripting";
import { sampleHasScript } from "@/lib/pipeline";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    requireEnv("ANTHROPIC_API_KEY");
    const chapter = db.select().from(chapters).where(eq(chapters.id, id)).get();
    if (!chapter) throw new AppError("Chapter not found", "not_found", 404);
    if (chapter.status === "scripting" || chapter.status === "generating") {
      throw new AppError("Chapter is busy", "busy", 409);
    }

    const jobId = createJob("script", chapter.bookId, id);
    db.update(chapters).set({ status: "scripting", error: null }).where(eq(chapters.id, id)).run();

    after(async () => {
      try {
        await withHeartbeat(jobId, () => scriptChapter(id, { jobId }));
        completeJob(jobId);
      } catch (err) {
        if (err instanceof JobCancelledError) {
          db.update(chapters)
            .set({ status: sampleHasScript(id) ? "scripted" : "pending", error: null })
            .where(eq(chapters.id, id))
            .run();
          return;
        }
        console.error(`Scripting failed (${id}):`, err);
        failJob(jobId, err);
        db.update(chapters)
          .set({ status: "error", error: err instanceof Error ? err.message : String(err) })
          .where(eq(chapters.id, id))
          .run();
      }
    });

    return Response.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
