import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, chapters, characters, segments } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { DELIVERY_VALUES, type Delivery } from "@/lib/delivery";

const bodySchema = z.object({
  characterId: z.string().nullable().optional(), // null = narrator
  delivery: z.enum(DELIVERY_VALUES).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = bodySchema.parse(await req.json());
    if (body.characterId === undefined && body.delivery === undefined) {
      throw new AppError("Nothing to update", "bad_request");
    }

    const segment = db.select().from(segments).where(eq(segments.id, id)).get();
    if (!segment) throw new AppError("Segment not found", "not_found", 404);
    if (segment.kind === "sfx") {
      throw new AppError("Sound-effect rows can only be deleted", "sfx_immutable", 409);
    }
    const chapter = db.select().from(chapters).where(eq(chapters.id, segment.chapterId)).get();
    if (!chapter) throw new AppError("Chapter not found", "not_found", 404);

    const patch: Partial<{
      characterId: string | null;
      kind: "narration" | "dialogue";
      flagged: boolean;
      delivery: Delivery | null;
      audioPath: null;
    }> = { audioPath: null };

    if (body.characterId !== undefined) {
      if (body.characterId) {
        const character = db
          .select({ id: characters.id, bookId: characters.bookId })
          .from(characters)
          .where(eq(characters.id, body.characterId))
          .get();
        if (!character || character.bookId !== chapter.bookId) {
          throw new AppError("Character not found in this book", "not_found", 404);
        }
      }
      patch.characterId = body.characterId;
      patch.kind = body.characterId ? segment.kind : "narration";
      patch.flagged = false;
      if (!body.characterId) patch.delivery = null; // narrator lines carry no note
    }

    if (body.delivery !== undefined) {
      if (body.delivery && segment.kind !== "dialogue") {
        throw new AppError("Delivery notes only apply to dialogue lines", "bad_delivery");
      }
      patch.delivery = body.delivery;
    }

    db.update(segments).set(patch).where(eq(segments.id, id)).run();

    // Existing chapter audio no longer matches the script
    if (chapter.status === "ready") {
      db.update(chapters).set({ status: "stale" }).where(eq(chapters.id, chapter.id)).run();
    }

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const segment = db.select().from(segments).where(eq(segments.id, id)).get();
    if (!segment) throw new AppError("Segment not found", "not_found", 404);
    if (segment.kind !== "sfx") {
      // Deleting speech would silently drop book text
      throw new AppError("Only sound-effect rows can be deleted", "not_sfx", 409);
    }
    const chapter = db.select().from(chapters).where(eq(chapters.id, segment.chapterId)).get();

    db.delete(segments).where(eq(segments.id, id)).run();
    if (chapter?.status === "ready") {
      db.update(chapters).set({ status: "stale" }).where(eq(chapters.id, chapter.id)).run();
    }

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
