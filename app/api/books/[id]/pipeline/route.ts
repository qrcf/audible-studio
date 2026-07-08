import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { getDb, books, chapters, characters, voiceAssignments } from "@/lib/db";
import type { PipelineStage } from "@/lib/db/schema";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { attachRunId, createJob } from "@/lib/jobs";
import { pickSampleChapter, sampleHasScript } from "@/lib/pipeline";
import { analyzeWorkflow } from "@/workflows/analyze";
import { castWorkflow } from "@/workflows/cast";
import { sampleGenerateWorkflow, sampleStageWorkflow } from "@/workflows/sample";

type Action = "start" | "approve_cast" | "approve_voices" | "dismiss" | "retry";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { action } = (await req.json().catch(() => ({}))) as { action?: Action };
    const db = getDb();
    const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (!book) throw new AppError("Book not found", "not_found", 404);

    switch (action) {
      case "start": {
        requireEnv("ANTHROPIC_API_KEY");
        if (book.pipelineStage) {
          throw new AppError("Guided setup is already running", "wrong_stage", 409);
        }
        return Response.json(await startOrSkipAhead(id, book.status));
      }

      case "approve_cast": {
        requireEnv("ANTHROPIC_API_KEY");
        requireEnv("ELEVENLABS_API_KEY");
        expectStage(book.pipelineStage, "cast_review");
        return Response.json(await dispatchCasting(id));
      }

      case "approve_voices": {
        requireEnv("ANTHROPIC_API_KEY");
        requireEnv("ELEVENLABS_API_KEY");
        expectStage(book.pipelineStage, "voice_review");
        await requireAllVoicesAssigned(id);
        return Response.json(await dispatchSample(id, { skipScriptIfPresent: false }));
      }

      case "dismiss": {
        await db.update(books).set({ pipelineStage: null }).where(eq(books.id, id));
        return Response.json({ pipelineStage: null });
      }

      case "retry": {
        switch (book.pipelineStage) {
          case "analyzing": {
            requireEnv("ANTHROPIC_API_KEY");
            if (book.status === "analyzing") throw new AppError("Analysis is running", "busy", 409);
            const jobId = await createJob("analyze", id);
            await db.update(books).set({ status: "analyzing", error: null }).where(eq(books.id, id));
            const run = await start(analyzeWorkflow, [id, jobId]);
            await attachRunId(jobId, run.runId);
            return Response.json({ pipelineStage: "analyzing", jobId });
          }
          case "casting": {
            requireEnv("ANTHROPIC_API_KEY");
            requireEnv("ELEVENLABS_API_KEY");
            if (book.status === "casting" && !book.error) {
              throw new AppError("Casting is running", "busy", 409);
            }
            return Response.json(await dispatchCasting(id));
          }
          case "scripting_sample":
          case "generating_sample": {
            requireEnv("ANTHROPIC_API_KEY");
            requireEnv("ELEVENLABS_API_KEY");
            return Response.json(await dispatchSample(id, { skipScriptIfPresent: true }));
          }
          default:
            // Review gates and sample_ready have nothing to retry
            return Response.json({ pipelineStage: book.pipelineStage ?? null });
        }
      }

      default:
        throw new AppError("Unknown pipeline action", "bad_action");
    }
  } catch (err) {
    return errorResponse(err);
  }
}

function expectStage(current: PipelineStage | null, expected: PipelineStage): void {
  if (current !== expected) {
    throw new AppError(
      `Pipeline is ${current ? `at "${current}"` : "not running"}, expected "${expected}"`,
      "wrong_stage",
      409
    );
  }
}

/** start: skip ahead past steps that are already done. */
async function startOrSkipAhead(bookId: string, bookStatus: string) {
  const db = getDb();
  const cast = await db
    .select({ id: characters.id, assignmentId: voiceAssignments.id })
    .from(characters)
    .leftJoin(voiceAssignments, eq(voiceAssignments.characterId, characters.id))
    .where(eq(characters.bookId, bookId));

  if (cast.length === 0) {
    if (bookStatus === "analyzing") throw new AppError("Analysis is running", "busy", 409);
    const jobId = await createJob("analyze", bookId);
    await db
      .update(books)
      .set({ status: "analyzing", error: null, pipelineStage: "analyzing" })
      .where(eq(books.id, bookId));
    const run = await start(analyzeWorkflow, [bookId, jobId]);
    await attachRunId(jobId, run.runId);
    return { pipelineStage: "analyzing", jobId };
  }

  const stage = cast.every((c) => c.assignmentId) ? "voice_review" : "cast_review";
  await db.update(books).set({ pipelineStage: stage }).where(eq(books.id, bookId));
  return { pipelineStage: stage };
}

async function dispatchCasting(bookId: string) {
  const jobId = await createJob("cast", bookId);
  await getDb()
    .update(books)
    .set({ status: "casting", error: null, pipelineStage: "casting" })
    .where(eq(books.id, bookId));
  const run = await start(castWorkflow, [bookId, jobId]);
  await attachRunId(jobId, run.runId);
  return { pipelineStage: "casting", jobId };
}

async function requireAllVoicesAssigned(bookId: string): Promise<void> {
  const missing = (
    await getDb()
      .select({ name: characters.name, assignmentId: voiceAssignments.id })
      .from(characters)
      .leftJoin(voiceAssignments, eq(voiceAssignments.characterId, characters.id))
      .where(eq(characters.bookId, bookId))
  ).filter((c) => !c.assignmentId);
  if (missing.length > 0) {
    throw new AppError(
      `No voice assigned for: ${missing.map((m) => m.name).join(", ")}`,
      "uncast"
    );
  }
}

async function dispatchSample(bookId: string, { skipScriptIfPresent }: { skipScriptIfPresent: boolean }) {
  const db = getDb();
  const sample = await pickSampleChapter(bookId);
  if (!sample) throw new AppError("Book has no chapters", "no_chapters");
  if (sample.status === "scripting" || sample.status === "generating") {
    throw new AppError("Sample chapter is busy", "busy", 409);
  }

  if (skipScriptIfPresent && sample.status !== "error" && (await sampleHasScript(sample.id))) {
    await db
      .update(books)
      .set({ pipelineStage: "generating_sample" })
      .where(eq(books.id, bookId));
    await start(sampleGenerateWorkflow, [bookId, sample.id]);
    return { pipelineStage: "generating_sample" };
  }

  const jobId = await createJob("script", bookId, sample.id);
  await db
    .update(chapters)
    .set({ status: "scripting", error: null })
    .where(eq(chapters.id, sample.id));
  await db
    .update(books)
    .set({ pipelineStage: "scripting_sample" })
    .where(eq(books.id, bookId));
  const run = await start(sampleStageWorkflow, [bookId, sample.id, jobId]);
  await attachRunId(jobId, run.runId);
  return { pipelineStage: "scripting_sample", jobId };
}
