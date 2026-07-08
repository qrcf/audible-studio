import { asc, eq } from "drizzle-orm";
import { db, chapters, characters, segments } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const chapter = db
    .select({ id: chapters.id, bookId: chapters.bookId })
    .from(chapters)
    .where(eq(chapters.id, id))
    .get();
  if (!chapter) return Response.json({ error: "Not found" }, { status: 404 });

  const rows = db
    .select({
      id: segments.id,
      idx: segments.idx,
      characterId: segments.characterId,
      kind: segments.kind,
      text: segments.text,
      flagged: segments.flagged,
      delivery: segments.delivery,
      sfxDurationSec: segments.sfxDurationSec,
      hasAudio: segments.audioPath,
    })
    .from(segments)
    .where(eq(segments.chapterId, id))
    .orderBy(asc(segments.idx))
    .all();

  const cast = db
    .select({ id: characters.id, name: characters.name, isNarrator: characters.isNarrator })
    .from(characters)
    .where(eq(characters.bookId, chapter.bookId))
    .all();

  return Response.json({
    segments: rows.map((r) => ({ ...r, hasAudio: Boolean(r.hasAudio) })),
    characters: cast,
  });
}
