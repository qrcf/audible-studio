import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/llm";

export interface DetectedChapter {
  title: string;
  text: string;
}

export interface DetectionResult {
  chapters: DetectedChapter[];
  method: "heuristic" | "llm" | "sections" | "single";
}

const WORD_NUM =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?|forty|fifty)";

const HEADING_PATTERNS: RegExp[] = [
  new RegExp(
    `^(?:chapter|part|book|canto|act|stave)[\\s.:—-]*(?:\\d{1,4}|[ivxlcdm]{1,8}|${WORD_NUM})?\\b.{0,45}$`,
    "i"
  ),
  /^(?:prologue|epilogue|introduction|preface|foreword|interlude|afterword)\b.{0,35}$/i,
  /^[IVXLCDM]{1,8}\.?$/, // standalone roman numeral
  /^\d{1,3}\.?$/, // standalone number
];

interface HeadingCandidate {
  lineIdx: number;
  offset: number; // char offset of the heading line start
  bodyOffset: number; // char offset just after the heading line
  heading: string;
}

/**
 * Split book text into chapters. Heuristic heading match first; if that finds
 * fewer than 2 chapters, optionally ask the LLM to identify headings among
 * short standalone lines; finally fall back to fixed-size sections or a
 * single chapter.
 */
export async function detectChapters(
  text: string,
  { allowLlm }: { allowLlm: boolean }
): Promise<DetectionResult> {
  const lines = text.split("\n");
  const offsets: number[] = new Array(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = pos;
    pos += lines[i].length + 1;
  }

  const shortStandalone: HeadingCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > 60) continue;
    if (i > 0 && lines[i - 1].trim() !== "") continue; // must follow a blank line or doc start
    shortStandalone.push({
      lineIdx: i,
      offset: offsets[i],
      bodyOffset: offsets[i] + lines[i].length + 1,
      heading: t,
    });
  }

  const heuristic = shortStandalone.filter((c) =>
    HEADING_PATTERNS.some((re) => re.test(c.heading))
  );
  if (isPlausibleSplit(heuristic, text.length)) {
    return {
      chapters: buildChapters(text, withSubtitles(heuristic, lines, offsets)),
      method: "heuristic",
    };
  }

  if (allowLlm && shortStandalone.length >= 2) {
    try {
      const llmPicked = await llmPickHeadings(shortStandalone, text.length);
      if (isPlausibleSplit(llmPicked, text.length)) {
        return {
          chapters: buildChapters(text, withSubtitles(llmPicked, lines, offsets)),
          method: "llm",
        };
      }
    } catch (err) {
      console.warn("LLM chapter detection failed, falling back to sections:", err);
    }
  }

  if (text.length > 25_000) {
    return { chapters: splitIntoSections(text), method: "sections" };
  }
  return { chapters: [{ title: "Chapter 1", text }], method: "single" };
}

function isPlausibleSplit(candidates: HeadingCandidate[], totalLen: number): boolean {
  if (candidates.length < 2) return false;
  // Chapters should average at least ~800 chars, otherwise we probably matched a list
  return totalLen / candidates.length >= 800;
}

function buildChapters(text: string, candidates: HeadingCandidate[]): DetectedChapter[] {
  const chapters: DetectedChapter[] = [];
  const pre = text.slice(0, candidates[0].offset).trim();
  if (pre.length > 500) {
    chapters.push({ title: "Front Matter", text: pre });
  }
  for (let i = 0; i < candidates.length; i++) {
    const start = candidates[i].bodyOffset;
    const end = i + 1 < candidates.length ? candidates[i + 1].offset : text.length;
    const body = text.slice(start, end).trim();
    if (!body) continue;
    chapters.push({ title: cleanTitle(candidates[i].heading), text: body });
  }
  return chapters;
}

function cleanTitle(heading: string): string {
  return heading.replace(/\s+/g, " ").replace(/[.:\s]+$/, "").trim();
}

/**
 * "CHAPTER I." is often followed by a short title line ("Down the Rabbit-Hole");
 * fold it into the display title and move bodyOffset past it so the subtitle
 * isn't narrated as prose (scripting emits a proper title announcement instead).
 */
function withSubtitles(
  candidates: HeadingCandidate[],
  lines: string[],
  offsets: number[]
): HeadingCandidate[] {
  return candidates.map((c) => {
    for (let i = c.lineIdx + 1; i <= c.lineIdx + 2 && i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      const followedByBlank = i + 1 >= lines.length || lines[i + 1].trim() === "";
      if (
        t.length <= 60 &&
        followedByBlank &&
        !HEADING_PATTERNS.some((re) => re.test(t))
      ) {
        return {
          ...c,
          heading: `${cleanTitle(c.heading)} — ${t}`,
          bodyOffset: offsets[i] + lines[i].length + 1,
        };
      }
      break; // first non-empty line wasn't a subtitle
    }
    return c;
  });
}

async function llmPickHeadings(
  candidates: HeadingCandidate[],
  totalLen: number
): Promise<HeadingCandidate[]> {
  const capped = candidates.slice(0, 200);
  const listing = capped
    .map((c, i) => `${i}: ${JSON.stringify(c.heading)} (at ${Math.round((c.offset / totalLen) * 100)}%)`)
    .join("\n");

  const { object } = await generateObject({
    model: getModel(),
    schema: z.object({
      headingIndexes: z
        .array(z.number().int())
        .describe("Indexes of lines that are true chapter headings, in document order"),
    }),
    prompt: `Below are short standalone lines from a book, each with its index and rough position in the document. Identify which are chapter (or section) headings that divide the book's main content. Exclude title pages, author names, table-of-contents entries (these cluster near 0%), running headers, and stray short lines of prose or dialogue. If the book has no chapter structure, return an empty array.\n\n${listing}`,
  });

  return object.headingIndexes
    .filter((i) => i >= 0 && i < capped.length)
    .sort((a, b) => a - b)
    .map((i) => capped[i]);
}

function splitIntoSections(text: string): DetectedChapter[] {
  const TARGET = 14_000;
  const paragraphs = text.split(/\n\n+/);
  const sections: DetectedChapter[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length > TARGET) {
      sections.push({ title: `Section ${sections.length + 1}`, text: current });
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current.trim()) {
    sections.push({ title: `Section ${sections.length + 1}`, text: current });
  }
  return sections;
}
