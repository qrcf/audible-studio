// Key-free verification harness for the pause pipeline: policy table,
// silent-frame generation, edge-silence measurement, boundary derivation.
// Usage: node scripts/check-pauses.mjs
import { Mp3Encoder } from "@breezystack/lamejs";
import { MPEGDecoder } from "mpg123-decoder";
import {
  FRAME_SEC,
  concatMp3,
  frameOffsets,
  measureEdgeSilence,
  silenceMp3,
} from "../lib/audio/mp3.ts";
import { targetPauseSec } from "../lib/audio/pauses.ts";
import { deriveSegmentBoundaries } from "../lib/analysis/boundaries.ts";
import { cleanChapterText, titleAnnouncement } from "../lib/analysis/clean.ts";

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// --- Pause policy table -----------------------------------------------------
console.log("\n=== targetPauseSec policy");
const narr = (text) => ({ kind: "narration", text, characterId: null });
const dlg = (text, characterId = "c1") => ({ kind: "dialogue", text, characterId });
const base = { paraBreakBefore: false, prevIsTitle: false };

check(targetPauseSec({ ...base, prev: null, cur: dlg("x") }) === 0, "first segment → 0");
check(
  targetPauseSec({ ...base, prev: narr("Chapter 1."), cur: narr("x"), prevIsTitle: true }) === 0,
  "after title announcement → 0 (suffix baked into its audio)"
);
check(
  targetPauseSec({
    prev: { kind: "sfx", text: "door slam", characterId: null },
    cur: narr("x"),
    paraBreakBefore: true,
    prevIsTitle: false,
  }) === 0.6,
  "out of sfx → 0.6 (beats paragraph)"
);
check(
  targetPauseSec({ ...base, prev: narr("He waited."), cur: dlg("x"), paraBreakBefore: true }) === 0.7,
  "paragraph break → 0.7"
);
check(
  targetPauseSec({ ...base, prev: narr("He waited."), cur: dlg("x") }) === 0.45,
  "sentence end + speaker change → 0.45"
);
check(
  targetPauseSec({ ...base, prev: narr("He waited."), cur: narr("x") }) === 0.35,
  "sentence end, same speaker → 0.35"
);
check(
  targetPauseSec({ ...base, prev: dlg("“Who are you?”"), cur: narr("x") }) === 0.45,
  "dialogue ‘?”’ into narration → 0.45 (closer-tolerant sentence end)"
);
check(
  targetPauseSec({ ...base, prev: dlg("“Well now,”"), cur: narr("x") }) === 0.18,
  "clause ‘,”’ → 0.18"
);
check(
  targetPauseSec({ ...base, prev: narr("he said"), cur: dlg("x") }) === 0.08,
  "mid-sentence attribution → 0.08"
);
check(
  targetPauseSec({ ...base, prev: dlg("“But—”"), cur: narr("x") }) === 0.08,
  "dash interruption stays tight → 0.08"
);

// --- Silent frame generation -------------------------------------------------
console.log("\n=== silenceMp3");
check(silenceMp3(0).data.length === 0, "zero target → empty buffer");
check(silenceMp3(-0.2).data.length === 0, "negative target (edges exceed it) → empty buffer");

const s7 = silenceMp3(0.7);
const s7frames = frameOffsets(s7.data);
check(s7frames.length === Math.round(0.7 / FRAME_SEC), "0.7s slices to round(0.7/FRAME_SEC) frames");
check(Math.abs(s7.sec - 0.7) < FRAME_SEC, "byte-derived sec within one frame of target");
check(
  Math.abs(s7.sec - (s7.data.length * 8) / 128_000) < 1e-9,
  "sec is exactly the pipeline's byte-length math"
);
check(
  concatMp3([s7.data]).data.length === s7.data.length,
  "concatMp3 leaves the silence slice untouched (no misdetected Xing frame)"
);

const decoder = new MPEGDecoder();
await decoder.ready;
const { channelData } = decoder.decode(new Uint8Array(s7.data));
decoder.free();
const pcm = channelData[0] ?? new Float32Array(0);
let loud = 0;
for (const s of pcm) if (Math.abs(s) >= 0.01) loud++;
check(pcm.length > 0 && loud === 0, `decodes to pure sub-threshold samples (${pcm.length} samples)`);

// --- Edge-silence measurement -------------------------------------------------
console.log("\n=== measureEdgeSilence");
function encodeClip(leadSec, toneSec, tailSec) {
  const rate = 44100;
  const n = Math.round((leadSec + toneSec + tailSec) * rate);
  const pcmIn = new Int16Array(n);
  const toneStart = Math.round(leadSec * rate);
  const toneEnd = toneStart + Math.round(toneSec * rate);
  for (let i = toneStart; i < toneEnd; i++) {
    pcmIn[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767);
  }
  const encoder = new Mp3Encoder(1, rate, 128);
  const chunks = [];
  for (let off = 0; off < n; off += 1152) {
    const out = encoder.encodeBuffer(pcmIn.subarray(off, Math.min(off + 1152, n)));
    if (out.length) chunks.push(Buffer.from(out));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

const clip = encodeClip(0.5, 0.5, 0.3);
const edges = await measureEdgeSilence(clip);
console.log(`  measured lead=${edges.leadSec.toFixed(3)}s tail=${edges.tailSec.toFixed(3)}s`);
check(edges.leadSec > 0.42 && edges.leadSec < 0.62, "0.5s lead-in measured (codec-delay tolerance)");
check(edges.tailSec > 0.22 && edges.tailSec < 0.42, "0.3s tail measured");

const noEdges = await measureEdgeSilence(encodeClip(0, 0.8, 0));
check(noEdges.leadSec < 0.08 && noEdges.tailSec < 0.08, "tone-to-the-edges clip measures ~0");

check(
  (await measureEdgeSilence(Buffer.from("not an mp3"))).leadSec === 0,
  "garbage input degrades to zero silence"
);

// --- Boundary derivation -------------------------------------------------------
console.log("\n=== deriveSegmentBoundaries");
const title = "Chapter I — Test";
const announcement = titleAnnouncement(title);
const text =
  'You were smiling. "Who are you?" You walked over.\n\nAnother paragraph.';
const segs = [
  { kind: "narration", text: announcement },
  { kind: "narration", text: "You were smiling." },
  { kind: "dialogue", text: '"Who are you?"' },
  { kind: "narration", text: "You walked over." },
  { kind: "sfx", text: "distant thunder" },
  { kind: "narration", text: "Another paragraph." },
];
const bounds = deriveSegmentBoundaries(cleanChapterText(text, title), announcement, segs);
check(bounds[0].isTitle, "title announcement flagged");
check(bounds[1].paraBreakBefore, "first text segment counts as paragraph start");
check(!bounds[2].paraBreakBefore && bounds[2].spaceBefore, "narration→dialogue gap is one space");
check(!bounds[3].paraBreakBefore && bounds[3].spaceBefore, "dialogue→narration gap is one space");
check(bounds[4].paraBreakBefore && !bounds[4].isTitle, "sfx row keeps defaults");
check(bounds[5].paraBreakBefore && !bounds[5].spaceBefore, "\\n\\n gap → paragraph break");

// The screenshot case end-to-end: narrator sentence → new voice → narrator.
const gap = targetPauseSec({
  ...base,
  prev: narr("You were smiling as you dropped them back over your eyes."),
  cur: dlg('"Who are you?"'),
});
const inserted = silenceMp3(gap - 0.1); // pretend clips carry 0.1s of edge silence
check(gap === 0.45 && inserted.sec > 0.3, "narrator→dialogue boundary yields an audible gap");

// --- Full stitch simulation (mirrors finalizeChapter's loop) --------------------
console.log("\n=== stitch simulation");
const { segmentAudioDurationSec } = await import("../lib/audio/mp3.ts");
const chapterSegs = [
  { kind: "narration", text: "You were smiling.", characterId: null },
  { kind: "dialogue", text: '"Who are you?"', characterId: "frankie" },
  { kind: "narration", text: "You walked over.", characterId: null },
  { kind: "narration", text: "Another paragraph.", characterId: null },
];
const clips = [
  encodeClip(0.05, 1.0, 0.3), // fat tail: next boundary's target gets fully absorbed
  encodeClip(0.2, 0.6, 0.05),
  encodeClip(0.02, 0.9, 0.3),
  encodeClip(0.05, 1.2, 0.1),
];
const simBounds = deriveSegmentBoundaries(cleanChapterText(text, title), announcement, chapterSegs);
const simEdges = [];
for (const c of clips) simEdges.push(await measureEdgeSilence(c));

const parts = [];
const simPauses = new Array(chapterSegs.length).fill(0);
const simTargets = new Array(chapterSegs.length).fill(0);
for (let i = 0; i < chapterSegs.length; i++) {
  if (i > 0) {
    simTargets[i] = targetPauseSec({
      prev: chapterSegs[i - 1],
      cur: chapterSegs[i],
      paraBreakBefore: simBounds[i].paraBreakBefore,
      prevIsTitle: simBounds[i - 1].isTitle,
    });
    const { data, sec } = silenceMp3(
      simTargets[i] - simEdges[i - 1].tailSec - simEdges[i].leadSec
    );
    if (data.length > 0) {
      parts.push(data);
      simPauses[i] = sec;
    }
  }
  parts.push(clips[i]);
}
const stitched = concatMp3(parts);
const expected =
  clips.reduce((sum, c) => sum + segmentAudioDurationSec(c), 0) +
  simPauses.reduce((a, b) => a + b, 0);
console.log(
  `  inserted: [${simPauses.map((p) => p.toFixed(3)).join(", ")}]s · chapter ${stitched.durationSec.toFixed(3)}s`
);
check(
  Math.abs(stitched.durationSec - expected) < 1e-9,
  "chapter duration === Σ(segment durations + pauses) exactly (read-along invariant)"
);
check(simPauses[1] === 0, "boundary already wider than target inserts nothing");
for (const i of [2, 3]) {
  const perceived = simEdges[i - 1].tailSec + simPauses[i] + simEdges[i].leadSec;
  check(
    Math.abs(perceived - simTargets[i]) < FRAME_SEC + 0.035,
    `boundary ${i}: perceived gap ${perceived.toFixed(3)}s ≈ target ${simTargets[i]}s`
  );
}
const stitchedFrames = frameOffsets(stitched.data);
check(stitchedFrames.length > 0, "stitched chapter parses as a clean frame stream");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
