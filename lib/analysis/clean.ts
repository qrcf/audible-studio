// Pure text-cleanup helpers shared by parsing and scripting. Zero imports so
// they also run in a bare node script (scripts/check-tokenizer.mjs).

const EMPHASIS_RE = /_([^_]{1,400}?)_/g;

/** Strip Gutenberg-style `_emphasis_` markers, keeping the inner text. */
export function stripEmphasis(text: string): string {
  return text.replace(EMPHASIS_RE, (match, inner: string) =>
    inner.includes("\n\n") ? match : inner
  );
}

/**
 * Cleanup applied at scripting time. Idempotent, so it also repairs books
 * uploaded before parsing stripped emphasis and removed subtitle lines:
 * a leading line that duplicates the tail of the chapter title is dropped.
 */
export function cleanChapterText(text: string, title: string): string {
  const out = stripEmphasis(text);
  const lines = out.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const first = lines[i]?.trim() ?? "";
  const normFirst = normalizeForMatch(first);
  if (normFirst && first.length <= 60 && normalizeForMatch(title).endsWith(normFirst)) {
    return lines
      .slice(i + 1)
      .join("\n")
      .trim();
  }
  return out.trim();
}

/**
 * Spoken chapter announcement: "CHAPTER I — Down the Rabbit-Hole" →
 * "Chapter 1. Down the Rabbit-Hole." Returns null for auto-generated
 * titles that shouldn't be announced.
 */
export function titleAnnouncement(title: string): string | null {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t || /^(section \d+|front matter)$/i.test(t)) return null;
  let out = t.replace(
    /^(chapter|part|book|canto|act|stave)([\s.:]+)([ivxlcdm]+)\b/i,
    (match, word: string, _sep: string, numeral: string) => {
      const n = romanToArabic(numeral.toLowerCase());
      return n === null ? match : `${capitalize(word)} ${n}`;
    }
  );
  out = out.replace(/^(chapter|part|book|canto|act|stave)\b/i, (w) => capitalize(w));
  out = out.replace(/\s*[—–]\s*/g, ". ").replace(/[.:\s]+$/, "");
  return `${out}.`;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function capitalize(word: string): string {
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

const ROMAN_VALUES: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

function romanToArabic(numeral: string): number | null {
  let total = 0;
  let prev = 0;
  for (let i = numeral.length - 1; i >= 0; i--) {
    const value = ROMAN_VALUES[numeral[i]];
    if (!value) return null;
    total += value < prev ? -value : value;
    prev = value;
  }
  return total > 0 ? total : null;
}
