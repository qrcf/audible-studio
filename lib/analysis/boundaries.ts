// Recovers what sat between adjacent segments in the original chapter text.
// Whitespace between segments was trimmed at storage, so both read-along
// rendering (paragraph breaks, inline spaces) and stitch-time pause insertion
// re-derive it here. Zero imports so it also runs in a bare node script —
// callers compose with cleanChapterText/titleAnnouncement from ./clean.

export interface BoundarySegment {
  kind: "narration" | "dialogue" | "sfx";
  text: string;
}

export interface SegmentBoundary {
  /** A paragraph break sits in the trimmed gap before this segment. */
  paraBreakBefore: boolean;
  /** An inline space belongs before it (else `"Well now,"he rumbled`). */
  spaceBefore: boolean;
  /** This is the spoken title announcement (not part of the chapter text). */
  isTitle: boolean;
}

/**
 * Segment texts are ordered (near-)exact substrings of the cleaned chapter
 * text, so a monotonic indexOf walk recovers each segment's position and
 * whether a paragraph break sits in the trimmed gap before it. The spoken
 * title announcement and sfx rows aren't part of the chapter text.
 */
export function deriveSegmentBoundaries(
  cleaned: string,
  announcement: string | null,
  segs: readonly BoundarySegment[]
): SegmentBoundary[] {
  let cursor = 0;
  let anyMatched = false;

  const out: SegmentBoundary[] = [];
  for (const seg of segs) {
    const isTitle = seg.kind === "narration" && seg.text === announcement;
    let paraBreakBefore = true;
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
    out.push({ paraBreakBefore, spaceBefore, isTitle });
  }
  return out;
}
