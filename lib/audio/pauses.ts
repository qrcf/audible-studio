// Target perceived gap inserted before a segment at chapter stitch time,
// derived from the text at the boundary. Pure — the finalize step subtracts
// the edge silence the clips already carry and persists what it inserted
// (segments.pauseBeforeSec), so these constants can be retuned without
// desyncing chapters stitched under an older table.

export interface PauseSegment {
  kind: "narration" | "dialogue" | "sfx";
  text: string;
  characterId: string | null;
}

// A closer run (quotes/brackets) may sit after the punctuation that matters.
const SENTENCE_END_RE = /[.!?…]["”’')\]]*$/;
const CLAUSE_END_RE = /[,;:]["”’')\]]*$/;

export interface PauseInputs {
  /** Previous segment in idx order; null = first segment of the chapter. */
  prev: PauseSegment | null;
  cur: Pick<PauseSegment, "kind" | "characterId">;
  /** A paragraph break sits in the trimmed gap before `cur`. */
  paraBreakBefore: boolean;
  /** `prev` is the title announcement — its pauseSuffix is baked into its audio. */
  prevIsTitle: boolean;
}

export function targetPauseSec({ prev, cur, paraBreakBefore, prevIsTitle }: PauseInputs): number {
  if (!prev) return 0; // the chapter starts immediately
  if (prevIsTitle) return 0;
  if (prev.kind === "sfx" || cur.kind === "sfx") return 0.6;
  if (paraBreakBefore) return 0.7;
  const text = prev.text.trimEnd();
  if (SENTENCE_END_RE.test(text)) {
    // A new voice needs slightly more room than the same one continuing.
    return prev.characterId !== cur.characterId ? 0.45 : 0.35;
  }
  if (CLAUSE_END_RE.test(text)) return 0.18;
  // Mid-sentence handoff ('"Hi," she said') or a dash cut-off — stays tight.
  return 0.08;
}
