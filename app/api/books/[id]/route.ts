import { eq } from "drizzle-orm";
import { getDb, books, chapters, characters } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { isLlmModelId, type LlmStep, type ModelPrefs } from "@/lib/llm-models";
import { deleteBookAudio } from "@/lib/storage";

const LLM_STEP_KEYS: LlmStep[] = ["analyze", "cast", "script"];

function parseModelPrefs(value: unknown): ModelPrefs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("modelPrefs must be an object", "bad_model");
  }
  const prefs: ModelPrefs = {};
  for (const [key, model] of Object.entries(value)) {
    if (!LLM_STEP_KEYS.includes(key as LlmStep)) {
      throw new AppError(`Unknown pipeline step "${key}"`, "bad_model");
    }
    if (!isLlmModelId(model)) {
      throw new AppError(`Unknown model "${model}"`, "bad_model");
    }
    prefs[key as LlmStep] = model;
  }
  return prefs;
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const db = getDb();
  const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
  if (!book) return Response.json({ error: "Not found" }, { status: 404 });
  const bookChapters = await db
    .select({
      id: chapters.id,
      idx: chapters.idx,
      title: chapters.title,
      charCount: chapters.charCount,
      status: chapters.status,
    })
    .from(chapters)
    .where(eq(chapters.bookId, id));
  const cast = await db.select().from(characters).where(eq(characters.bookId, id));
  return Response.json({ ...book, chapters: bookChapters, characters: cast });
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as {
      renderModel?: string;
      title?: string;
      modelPrefs?: unknown;
      sfxEnabled?: unknown;
    };
    const patch: Partial<{
      renderModel: string;
      title: string;
      modelPrefs: ModelPrefs;
      sfxEnabled: boolean;
    }> = {};
    if (body.renderModel) {
      if (!["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5"].includes(body.renderModel)) {
        throw new AppError("Unknown render model", "bad_model");
      }
      patch.renderModel = body.renderModel;
    }
    if (body.sfxEnabled !== undefined) {
      if (typeof body.sfxEnabled !== "boolean") {
        throw new AppError("sfxEnabled must be a boolean", "bad_request");
      }
      patch.sfxEnabled = body.sfxEnabled;
    }
    if (body.modelPrefs !== undefined) patch.modelPrefs = parseModelPrefs(body.modelPrefs);
    if (body.title) patch.title = body.title;
    await getDb().update(books).set(patch).where(eq(books.id, id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    await getDb().delete(books).where(eq(books.id, id));
    await deleteBookAudio(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
