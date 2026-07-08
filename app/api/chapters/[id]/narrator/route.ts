import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, chapters, characters, segments } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { titleAnnouncement } from "@/lib/analysis/clean";

const bodySchema = z.object({
  characterId: z.string().nullable(), // null = book narrator
});

/** Point every narration segment of the chapter at one narrating character. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = bodySchema.parse(await req.json());
    const db = getDb();

    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
    if (!chapter) throw new AppError("Chapter not found", "not_found", 404);

    if (body.characterId) {
      const [character] = await db
        .select({
          id: characters.id,
          bookId: characters.bookId,
          isNarrator: characters.isNarrator,
        })
        .from(characters)
        .where(eq(characters.id, body.characterId))
        .limit(1);
      if (!character || character.bookId !== chapter.bookId) {
        throw new AppError("Character not found in this book", "not_found", 404);
      }
      if (character.isNarrator) {
        throw new AppError("Pass null for the book narrator", "bad_request");
      }
    }

    // The chapter-title announcement stays with the book narrator
    const announce = titleAnnouncement(chapter.title);
    const rows = await db
      .select({ id: segments.id, idx: segments.idx, text: segments.text })
      .from(segments)
      .where(and(eq(segments.chapterId, id), eq(segments.kind, "narration")));
    const targets = rows.filter((r) => !(r.idx === 0 && r.text === announce));

    await db.transaction(async (tx) => {
      if (targets.length > 0) {
        await tx
          .update(segments)
          .set({ characterId: body.characterId, audioPath: null })
          .where(
            inArray(
              segments.id,
              targets.map((r) => r.id)
            )
          );
      }
      // Existing chapter audio no longer matches the script
      if (chapter.status === "ready") {
        await tx.update(chapters).set({ status: "stale" }).where(eq(chapters.id, chapter.id));
      }
    });

    return Response.json({ ok: true, updated: targets.length });
  } catch (err) {
    return errorResponse(err);
  }
}
