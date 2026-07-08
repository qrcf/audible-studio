import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { getDb, books, chapters, characters, voiceAssignments, bookShares } from "@/lib/db";
import { readAuthContext } from "@/lib/auth/session";
import { BookView } from "@/components/book/book-view";
import type { BookData, ChapterMeta, CharacterData } from "@/components/book/types";

export const dynamic = "force-dynamic";

const getBook = cache(async (id: string) => {
  const [book] = await getDb().select().from(books).where(eq(books.id, id)).limit(1);
  return book;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const book = await getBook((await params).id);
  return { title: book ? `${book.title} · Audiobook Studio` : "Audiobook Studio" };
}

export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  // The chapter/character queries only need the id — run all three together
  // instead of gating them on the book lookup.
  const [book, chapterRows, characterRows] = await Promise.all([
    getBook(id),
    db
      .select({
        id: chapters.id,
        idx: chapters.idx,
        title: chapters.title,
        charCount: chapters.charCount,
        status: chapters.status,
        durationSec: chapters.durationSec,
        audioPath: chapters.audioPath,
        error: chapters.error,
      })
      .from(chapters)
      .where(eq(chapters.bookId, id))
      .orderBy(asc(chapters.idx)),
    db
      .select()
      .from(characters)
      .leftJoin(voiceAssignments, eq(voiceAssignments.characterId, characters.id))
      .where(eq(characters.bookId, id)),
  ]);
  if (!book) notFound();

  // Share-link viewers are read-only and locked to their one book (the proxy
  // enforces this too; this is the page-level backstop).
  const ctx = await readAuthContext();
  const readOnly = ctx?.role === "viewer";
  if (ctx?.role === "viewer" && ctx.bookId !== id) notFound();

  // The owner's Share control needs the current link (if any); viewers never
  // see it, so skip the lookup for them.
  const [share] = readOnly
    ? []
    : await db.select({ token: bookShares.token }).from(bookShares).where(eq(bookShares.bookId, id)).limit(1);

  const bookData: BookData = {
    id: book.id,
    title: book.title,
    author: book.author,
    status: book.status,
    povType: book.povType,
    narratorProfile: book.narratorProfile,
    renderModel: book.renderModel,
    sfxEnabled: book.sfxEnabled,
    modelPrefs: book.modelPrefs,
    pipelineStage: book.pipelineStage,
    sourceFileName: book.sourceFileName,
    introAudioPath: book.introAudioPath,
    introDurationSec: book.introDurationSec,
    error: book.error,
  };

  const chapterData: ChapterMeta[] = chapterRows;

  const characterData: CharacterData[] = characterRows.map(
    ({ characters: c, voice_assignments: a }) => ({
      id: c.id,
      name: c.name,
      aliases: c.aliases,
      role: c.role,
      profile: c.profile,
      quotes: c.quotes,
      dialogueShare: c.dialogueShare,
      isNarrator: c.isNarrator,
      variantGroup: c.variantGroup,
      variantLabel: c.variantLabel,
      profileEdited: c.profileEdited,
      assignment: a
        ? {
            voiceId: a.voiceId,
            voiceName: a.voiceName,
            settings: a.settings,
            rationale: a.rationale,
            overridden: a.overridden,
          }
        : null,
    })
  );
  // Group-adjacent order: narrator first, groups ranked by their best-known
  // share, age variants of one character kept together (dominant first).
  const groupRank = new Map<string, number>();
  for (const c of characterData) {
    const key = c.variantGroup ?? c.name;
    groupRank.set(key, Math.max(groupRank.get(key) ?? 0, c.dialogueShare));
  }
  characterData.sort((x, y) => {
    const narrator = Number(y.isNarrator) - Number(x.isNarrator);
    if (narrator !== 0) return narrator;
    const gx = x.variantGroup ?? x.name;
    const gy = y.variantGroup ?? y.name;
    if (gx !== gy) {
      return groupRank.get(gy)! - groupRank.get(gx)! || gx.localeCompare(gy);
    }
    return y.dialogueShare - x.dialogueShare;
  });

  return (
    <BookView
      book={bookData}
      chapters={chapterData}
      characters={characterData}
      readOnly={readOnly}
      shareToken={share?.token ?? null}
      keys={{
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
        eleven: Boolean(process.env.ELEVENLABS_API_KEY),
      }}
    />
  );
}
