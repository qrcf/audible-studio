import { asc, eq } from "drizzle-orm";
import { getDb, chapters, characters, segments } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { viewerDeniedForBook } from "@/lib/auth/session";
import { cleanChapterText, titleAnnouncement } from "@/lib/analysis/clean";

/**
 * The chapter MP3 is a CBR byte-concatenation of the per-segment audio, and
 * each segment's exact duration was captured at generation time
 * (segments.durationSec) — start times are pure addition, no audio reads.
 * Timing stays valid for stale chapters too (their audio was built from
 * these same segments).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
    if (!chapter) throw new AppError("Chapter not found", "not_found", 404);
    if (await viewerDeniedForBook(chapter.bookId)) {
      throw new AppError("Chapter not found", "not_found", 404);
    }
    if (!chapter.audioPath) {
      throw new AppError("Generate this chapter first", "not_generated", 409);
    }

    const segs = await db
      .select()
      .from(segments)
      .where(eq(segments.chapterId, id))
      .orderBy(asc(segments.idx));
    if (segs.length === 0) throw new AppError("Chapter has no script", "not_scripted", 409);

    const nameById = new Map(
      (
        await db
          .select({ id: characters.id, name: characters.name })
          .from(characters)
          .where(eq(characters.bookId, chapter.bookId))
      ).map((c) => [c.id, c.name])
    );

    // Segment texts are ordered (near-)exact substrings of the cleaned chapter
    // text, so a monotonic indexOf walk recovers each segment's position and
    // whether a paragraph break sits in the trimmed gap before it. The spoken
    // title announcement and sfx rows aren't part of the chapter text.
    const cleaned = cleanChapterText(chapter.text, chapter.title);
    const announcement = titleAnnouncement(chapter.title);
    let cursor = 0;
    let anyMatched = false;

    let startSec = 0;
    const timed = [];
    for (const seg of segs) {
      if (!seg.audioPath || seg.durationSec == null) {
        // Re-scripted since generation — the chapter audio no longer matches
        throw new AppError(
          "Read-along timing is out of date — regenerate this chapter",
          "no_timing",
          409
        );
      }
      const isTitle = seg.kind === "narration" && seg.text === announcement;
      let paraBreakBefore = true;
      // Whitespace between adjacent segments was trimmed at storage, so
      // recover whether an inline space belongs before this segment (else
      // `"Well now,"he rumbled` renders with no gap).
      let spaceBefore = false;
      if (seg.kind !== "sfx" && !isTitle) {
        const at = cleaned.indexOf(seg.text, cursor);
        if (at >= 0) {
          const gap = cleaned.slice(cursor, at);
          paraBreakBefore = !anyMatched || /\n\s*\n/.test(gap);
          spaceBefore = !paraBreakBefore && gap.length > 0;
          cursor = at + seg.text.length;
          anyMatched = true;
        } else {
          // Merged-dialogue " " insert or \n\n\n rejoin — degrade gracefully
          paraBreakBefore = seg.kind === "narration";
          spaceBefore = !paraBreakBefore;
        }
      }
      const durationSec = seg.durationSec;
      timed.push({
        id: seg.id,
        idx: seg.idx,
        characterId: seg.characterId,
        characterName:
          seg.kind === "sfx"
            ? "Sound effect"
            : seg.characterId
              ? (nameById.get(seg.characterId) ?? "?")
              : "Narrator",
        kind: seg.kind,
        text: seg.text,
        startSec,
        durationSec,
        paraBreakBefore,
        spaceBefore,
        isTitle,
        phrases: timePhrases(seg.text, startSec, durationSec),
      });
      startSec += durationSec;
    }

    return Response.json({ segments: timed });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Split a segment's text into clause-sized phrases (an exact partition — the
 * pieces concatenate back to the original) and spread the segment's KNOWN
 * exact duration across them by speech-weighted length: characters plus pause
 * bonuses for punctuation. Estimates re-anchor at every segment boundary, so
 * phrase timing stays within ~a second.
 */
function timePhrases(
  text: string,
  segStartSec: number,
  segDurationSec: number
): { text: string; startSec: number; durationSec: number }[] {
  const pieces = splitPhrases(text);
  const weights = pieces.map(phraseWeight);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let start = segStartSec;
  return pieces.map((piece, i) => {
    const durationSec = (segDurationSec * weights[i]) / totalWeight;
    const phrase = { text: piece, startSec: start, durationSec };
    start += durationSec;
    return phrase;
  });
}

// Cut after sentence enders (incl. trailing quotes/brackets) always, and after
// commas/dashes only when the piece is already long — keeps fragments readable.
const PHRASE_BOUNDARY = /[.!?;:…]+["”’)\]]*\s+|[,—]["”’)\]]*\s+/g;

function splitPhrases(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  PHRASE_BOUNDARY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PHRASE_BOUNDARY.exec(text))) {
    const end = m.index + m[0].length;
    const isSoft = m[0][0] === "," || m[0][0] === "—";
    if (end - start >= (isSoft ? 48 : 10)) {
      out.push(text.slice(start, end));
      start = end;
    }
  }
  if (start < text.length) {
    const rest = text.slice(start);
    if (rest.trim().length < 6 && out.length > 0) out[out.length - 1] += rest;
    else out.push(rest);
  }
  return out.length > 0 ? out : [text];
}

function phraseWeight(piece: string): number {
  const chars = piece.replace(/\s+/g, " ").trim().length;
  let pause = 0;
  if (/[.!?…]["”’)\]]*\s*$/.test(piece)) pause = 18; // sentence-final pause
  else if (/[,;:—]["”’)\]]*\s*$/.test(piece)) pause = 7; // clause pause
  return Math.max(chars, 1) + pause;
}
