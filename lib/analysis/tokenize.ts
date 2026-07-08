// Deterministic quote tokenizer. Splits chapter text into alternating
// narration/quote spans by exact character offsets — the spans partition the
// text (concat(spans.text) === text), so no words can ever be lost or
// misplaced. The LLM later only names each quote's speaker; it never controls
// segment boundaries. Zero imports so it runs in a bare node script.

export interface TextSpan {
  kind: "narration" | "quote";
  start: number;
  end: number; // exclusive; quote spans include the quote marks
  text: string;
  flagged: boolean; // suspected imbalance — surfaced for review in the UI
}

export type QuoteStyle = "curly" | "straight" | "single" | "none";

// A quote may legitimately stay open across paragraph breaks (embedded verse,
// a letter, an address block) — but past this many breaks it's almost
// certainly an unbalanced quote mark, so we force-close and flag it.
const MAX_PARAGRAPH_CROSSINGS = 3;

export function tokenizeQuotes(text: string): { spans: TextSpan[]; style: QuoteStyle } {
  const style = detectStyle(text);
  if (style === "none") {
    return {
      spans:
        text.length > 0
          ? [{ kind: "narration", start: 0, end: text.length, text, flagged: false }]
          : [],
      style,
    };
  }
  return { spans: scan(text, style), style };
}

function scan(text: string, style: Exclude<QuoteStyle, "none">): TextSpan[] {
  const isOpen = (i: number): boolean => {
    const ch = text[i];
    if (style === "curly") return ch === "“";
    if (style === "straight") return ch === '"';
    return (ch === "‘" || ch === "'") && isOpenContext(text, i);
  };
  const isClose = (i: number): boolean => {
    const ch = text[i];
    if (style === "curly") return ch === "”";
    if (style === "straight") return ch === '"';
    return (ch === "’" || ch === "'") && isCloseContext(text, i);
  };
  // Straight quotes are signless, so an open paragraph end is likelier a
  // missing close than an embedded block — don't let it span paragraphs.
  const stayOpen = style !== "straight";

  const paras = paragraphRanges(text);
  const spans: TextSpan[] = [];
  let cursor = 0;
  let inQuote = false;
  let quoteFlagged = false;
  let crossings = 0;

  const push = (kind: TextSpan["kind"], end: number, flagged = false) => {
    if (end > cursor) {
      spans.push({ kind, start: cursor, end, text: text.slice(cursor, end), flagged });
      cursor = end;
    }
  };

  for (let pi = 0; pi < paras.length; pi++) {
    const para = paras[pi];
    for (let i = Math.max(cursor, para.start); i < para.end; i++) {
      if (!inQuote) {
        if (isOpen(i)) {
          push("narration", i);
          inQuote = true;
          quoteFlagged = false;
          crossings = 0;
        }
      } else if (isClose(i)) {
        push("quote", i + 1, quoteFlagged);
        inQuote = false;
      } else if (isOpen(i)) {
        // A second opener while open: the previous close is missing.
        push("quote", i, true);
        inQuote = true;
        quoteFlagged = false;
        crossings = 0;
      }
    }

    if (inQuote) {
      // Quote still open at the paragraph's end. Victorian convention: a
      // quotation continuing into the next paragraph re-opens it with a fresh
      // mark and never closed the previous one — so if the next paragraph
      // starts with an opener, close here (unflagged) and let it reopen.
      const next = paras[pi + 1];
      const nextFirst = next ? firstNonSpace(text, next.start, next.end) : -1;
      if (nextFirst >= 0 && isOpen(nextFirst)) {
        push("quote", para.end, quoteFlagged);
        inQuote = false;
      } else if (!next || !stayOpen || crossings >= MAX_PARAGRAPH_CROSSINGS) {
        push("quote", para.end, true);
        inQuote = false;
      } else {
        // Embedded verse/letter/address: the quote genuinely continues.
        crossings++;
      }
    }
  }
  push("narration", text.length);
  return spans;
}

function detectStyle(text: string): QuoteStyle {
  let curly = 0;
  let straight = 0;
  for (const ch of text) {
    if (ch === "“") curly++;
    else if (ch === '"') straight++;
  }
  if (curly >= 2) return "curly";
  if (straight >= 2) return "straight";
  if (curly === 0 && straight === 0) {
    let singles = 0;
    for (let i = 0; i < text.length; i++) {
      if ((text[i] === "‘" || text[i] === "'") && isOpenContext(text, i)) singles++;
    }
    if (singles >= 4) return "single";
  }
  return "none";
}

function paragraphRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const re = /\n\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > start) ranges.push({ start, end: m.index });
    start = m.index + m[0].length;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

function firstNonSpace(text: string, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    if (!/\s/.test(text[i])) return i;
  }
  return -1;
}

const OPEN_CONTEXT_BEFORE = /[\s([{—–\-"“]/;

function isOpenContext(text: string, i: number): boolean {
  return i === 0 || OPEN_CONTEXT_BEFORE.test(text[i - 1]);
}

function isCloseContext(text: string, i: number): boolean {
  const prev = text[i - 1] ?? "";
  const next = text[i + 1] ?? "";
  // An apostrophe inside a word (don't, o'clock) is never a closing quote.
  if (/[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next)) return false;
  return next === "" || /[\s.,;:!?)\]}—–\-"”]/.test(next);
}
