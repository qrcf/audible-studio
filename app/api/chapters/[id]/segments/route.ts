import { asc, eq } from "drizzle-orm";
import { getDb, chapters, characters, segments } from "@/lib/db";
import { viewerDeniedForBook } from "@/lib/auth/session";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const [chapter] = await db
    .select({ id: chapters.id, bookId: chapters.bookId })
    .from(chapters)
    .where(eq(chapters.id, id))
    .limit(1);
  if (!chapter) return Response.json({ error: "Not found" }, { status: 404 });
  if (await viewerDeniedForBook(chapter.bookId)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
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
    .orderBy(asc(segments.idx));

  const cast = await db
    .select({ id: characters.id, name: characters.name, isNarrator: characters.isNarrator })
    .from(characters)
    .where(eq(characters.bookId, chapter.bookId));

  return Response.json({
    segments: rows.map((r) => ({ ...r, hasAudio: Boolean(r.hasAudio) })),
    characters: cast,
  });
}
