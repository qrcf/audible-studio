import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, books, chapters, characters, jobs, segments } from "@/lib/db";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { enqueueJob } from "@/lib/jobs";
import { refreshBookStatus } from "@/lib/generation";
import { dispatchAll } from "@/lib/queue";

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

    const chapterRows = await db
      .select({ id: chapters.id, status: chapters.status })
      .from(chapters)
      .where(eq(chapters.bookId, id))
      .orderBy(asc(chapters.idx));
    const pending = chapterRows.filter((c) => c.status !== "ready");
    if (pending.length === 0) return Response.json({ ok: true, queued: 0 });

    // Which chapters already have a script, and which already have a live
    // generate job (so a re-run doesn't double-enqueue).
    const scripted = new Set(
      (
        await db
          .select({ chapterId: segments.chapterId })
          .from(segments)
          .innerJoin(chapters, eq(segments.chapterId, chapters.id))
          .where(eq(chapters.bookId, id))
      ).map((s) => s.chapterId)
    );
    const active = new Set(
      (
        await db
          .select({ chapterId: jobs.chapterId })
          .from(jobs)
          .where(
            and(eq(jobs.bookId, id), eq(jobs.type, "generate"), inArray(jobs.status, ["queued", "running"]))
          )
      ).map((j) => j.chapterId)
    );

    let queued = 0;
    for (const c of pending) {
      if (active.has(c.id)) continue;
      const needsScript = !scripted.has(c.id) || c.status === "pending";
      await enqueueJob("generate", id, c.id, { scriptFirst: needsScript });
      queued++;
    }

    await db.update(books).set({ status: "generating" }).where(eq(books.id, id));
    await dispatchAll();
    await refreshBookStatus(id);
    return Response.json({ ok: true, queued });
  } catch (err) {
    return errorResponse(err);
  }
}
