import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, books, chapters, characters, voiceAssignments } from "@/lib/db";
import type { PipelineStage } from "@/lib/db/schema";
import { errorResponse, AppError, requireEnv } from "@/lib/errors";
import { createJob } from "@/lib/jobs";
import {
  generateSample,
  pickSampleChapter,
  runAnalysisStage,
  runCastingJob,
  runSampleStage,
  sampleHasScript,
} from "@/lib/pipeline";

type Action = "start" | "approve_cast" | "approve_voices" | "dismiss" | "retry";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { action } = (await req.json().catch(() => ({}))) as { action?: Action };
    const book = db.select().from(books).where(eq(books.id, id)).get();
    if (!book) throw new AppError("Book not found", "not_found", 404);

    switch (action) {
      case "start": {
        requireEnv("ANTHROPIC_API_KEY");
        if (book.pipelineStage) {
          throw new AppError("Guided setup is already running", "wrong_stage", 409);
        }
        return Response.json(startOrSkipAhead(id, book.status));
      }

      case "approve_cast": {
        requireEnv("ANTHROPIC_API_KEY");
        requireEnv("ELEVENLABS_API_KEY");
        expectStage(book.pipelineStage, "cast_review");
        return Response.json(dispatchCasting(id));
      }

      case "approve_voices": {
        requireEnv("ANTHROPIC_API_KEY");
        requireEnv("ELEVENLABS_API_KEY");
        expectStage(book.pipelineStage, "voice_review");
        requireAllVoicesAssigned(id);
        return Response.json(dispatchSample(id, { skipScriptIfPresent: false }));
      }

      case "dismiss": {
        db.update(books).set({ pipelineStage: null }).where(eq(books.id, id)).run();
        return Response.json({ pipelineStage: null });
      }

      case "retry": {
        switch (book.pipelineStage) {
          case "analyzing": {
            requireEnv("ANTHROPIC_API_KEY");
            if (book.status === "analyzing") throw new AppError("Analysis is running", "busy", 409);
            const jobId = createJob("analyze", id);
            db.update(books)
              .set({ status: "analyzing", error: null })
              .where(eq(books.id, id))
              .run();
            after(() => runAnalysisStage(id, jobId));
            return Response.json({ pipelineStage: "analyzing", jobId });
          }
          case "casting": {
            requireEnv("ANTHROPIC_API_KEY");
            requireEnv("ELEVENLABS_API_KEY");
            if (book.status === "casting" && !book.error) {
              throw new AppError("Casting is running", "busy", 409);
            }
            return Response.json(dispatchCasting(id));
          }
          case "scripting_sample":
          case "generating_sample": {
            requireEnv("ANTHROPIC_API_KEY");
            requireEnv("ELEVENLABS_API_KEY");
            return Response.json(dispatchSample(id, { skipScriptIfPresent: true }));
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
function startOrSkipAhead(bookId: string, bookStatus: string) {
  const cast = db
    .select({ id: characters.id, assignmentId: voiceAssignments.id })
    .from(characters)
    .leftJoin(voiceAssignments, eq(voiceAssignments.characterId, characters.id))
    .where(eq(characters.bookId, bookId))
    .all();

  if (cast.length === 0) {
    if (bookStatus === "analyzing") throw new AppError("Analysis is running", "busy", 409);
    const jobId = createJob("analyze", bookId);
    db.update(books)
      .set({ status: "analyzing", error: null, pipelineStage: "analyzing" })
      .where(eq(books.id, bookId))
      .run();
    after(() => runAnalysisStage(bookId, jobId));
    return { pipelineStage: "analyzing", jobId };
  }

  const stage = cast.every((c) => c.assignmentId) ? "voice_review" : "cast_review";
  db.update(books).set({ pipelineStage: stage }).where(eq(books.id, bookId)).run();
  return { pipelineStage: stage };
}

function dispatchCasting(bookId: string) {
  const jobId = createJob("cast", bookId);
  db.update(books)
    .set({ status: "casting", error: null, pipelineStage: "casting" })
    .where(eq(books.id, bookId))
    .run();
  after(() => runCastingJob(bookId, jobId));
  return { pipelineStage: "casting", jobId };
}

function requireAllVoicesAssigned(bookId: string): void {
  const missing = db
    .select({ name: characters.name, assignmentId: voiceAssignments.id })
    .from(characters)
    .leftJoin(voiceAssignments, eq(voiceAssignments.characterId, characters.id))
    .where(eq(characters.bookId, bookId))
    .all()
    .filter((c) => !c.assignmentId);
  if (missing.length > 0) {
    throw new AppError(
      `No voice assigned for: ${missing.map((m) => m.name).join(", ")}`,
      "uncast"
    );
  }
}

function dispatchSample(bookId: string, { skipScriptIfPresent }: { skipScriptIfPresent: boolean }) {
  const sample = pickSampleChapter(bookId);
  if (!sample) throw new AppError("Book has no chapters", "no_chapters");
  if (sample.status === "scripting" || sample.status === "generating") {
    throw new AppError("Sample chapter is busy", "busy", 409);
  }

  if (skipScriptIfPresent && sample.status !== "error" && sampleHasScript(sample.id)) {
    db.update(books)
      .set({ pipelineStage: "generating_sample" })
      .where(eq(books.id, bookId))
      .run();
    after(() => generateSample(bookId, sample.id));
    return { pipelineStage: "generating_sample" };
  }

  const jobId = createJob("script", bookId, sample.id);
  db.update(chapters)
    .set({ status: "scripting", error: null })
    .where(eq(chapters.id, sample.id))
    .run();
  db.update(books)
    .set({ pipelineStage: "scripting_sample" })
    .where(eq(books.id, bookId))
    .run();
  after(() => runSampleStage(bookId, sample.id, jobId));
  return { pipelineStage: "scripting_sample", jobId };
}
