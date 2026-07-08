import { asc, eq } from "drizzle-orm";
import { db, chapters, characters, segments } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { audioExists, readAudio } from "@/lib/paths";
import { segmentAudioDurationSec } from "@/lib/audio/mp3";

/**
 * The chapter MP3 is a CBR byte-concatenation of the per-segment cache files,
 * so each segment's start time is exact file-size math — no transcription
 * needed. Timing stays valid for stale chapters too (their audio was built
 * from these same files).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const chapter = db.select().from(chapters).where(eq(chapters.id, id)).get();
    if (!chapter) throw new AppError("Chapter not found", "not_found", 404);
    if (!chapter.audioPath) {
      throw new AppError("Generate this chapter first", "not_generated", 409);
    }

    const segs = db
      .select()
      .from(segments)
      .where(eq(segments.chapterId, id))
      .orderBy(asc(segments.idx))
      .all();
    if (segs.length === 0) throw new AppError("Chapter has no script", "not_scripted", 409);

    const nameById = new Map(
      db
        .select({ id: characters.id, name: characters.name })
        .from(characters)
        .where(eq(characters.bookId, chapter.bookId))
        .all()
        .map((c) => [c.id, c.name])
    );

    let startSec = 0;
    const timed = [];
    for (const seg of segs) {
      if (!seg.audioPath || !audioExists(seg.audioPath)) {
        // Re-scripted since generation — the chapter audio no longer matches
        throw new AppError(
          "Read-along timing is out of date — regenerate this chapter",
          "no_timing",
          409
        );
      }
      const durationSec = segmentAudioDurationSec(readAudio(seg.audioPath));
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
