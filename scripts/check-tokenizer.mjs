// Key-free verification harness for the pure scripting helpers.
// Usage: node scripts/check-tokenizer.mjs "<file>::<chapter title>" [...]
// (node >= 23.6 strips the .ts imports' types natively)
import { readFileSync } from "node:fs";
import { tokenizeQuotes } from "../lib/analysis/tokenize.ts";
import { cleanChapterText, titleAnnouncement } from "../lib/analysis/clean.ts";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

for (const arg of process.argv.slice(2)) {
  const [file, title = ""] = arg.split("::");
  const raw = readFileSync(file, "utf-8");
  const cleaned = cleanChapterText(raw, title);
  const { spans, style } = tokenizeQuotes(cleaned);

  console.log(`\n=== ${file} (title: ${JSON.stringify(title)}) — style: ${style}`);
  console.log(`  announcement: ${JSON.stringify(titleAnnouncement(title))}`);

  check(
    spans.map((s) => s.text).join("") === cleaned,
    "partition invariant: concat(spans) === cleaned text"
  );
  check(!cleaned.includes("_"), "no underscores after cleanup");
  if (title) {
    const firstLine = cleaned.split("\n", 1)[0].trim();
    check(
      !title.toLowerCase().includes(firstLine.toLowerCase()) || firstLine.length > 60,
      `subtitle line removed (body starts: ${JSON.stringify(firstLine.slice(0, 50))})`
    );
  }

  const quotes = spans.filter((s) => s.kind === "quote");
  const flagged = spans.filter((s) => s.flagged);
  console.log(
    `  ${spans.length} spans · ${quotes.length} quotes · ${flagged.length} flagged`
  );
  check(flagged.length === 0, "zero flagged spans");

  for (const q of quotes) {
    const oneLine = q.text.replace(/\s+/g, " ");
    const preview =
      oneLine.length <= 90 ? oneLine : `${oneLine.slice(0, 60)} … ${oneLine.slice(-25)}`;
    console.log(`    [q] ${preview}`);
  }
  for (const f of flagged) {
    console.log(`    [FLAGGED ${f.kind}] ${f.text.replace(/\s+/g, " ").slice(0, 100)}`);
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
