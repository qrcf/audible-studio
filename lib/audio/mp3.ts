// Byte-level utilities for OUTPUT_FORMAT mp3_44100_128 audio (MPEG1 Layer III,
// 44.1 kHz, CBR 128 kbps, mono) — concatenation, silent-frame generation and
// edge-silence measurement all operate on that one format. Only package
// imports, so scripts/check-pauses.mjs can run this file under bare node.
import { MPEGDecoder } from "mpg123-decoder";
import { Mp3Encoder } from "@breezystack/lamejs";

const BITRATE_BPS = 128_000; // OUTPUT_FORMAT mp3_44100_128 is constant-bitrate
const SAMPLE_RATE = 44100;
const FRAME_SAMPLES = 1152;
/** Duration of one frame (~26.12 ms) — the quantum every pause rounds to. */
export const FRAME_SEC = FRAME_SAMPLES / SAMPLE_RATE;

/** Strip an ID3v2 tag if present (size field is syncsafe). */
export function stripId3(buf: Buffer): Buffer {
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    return buf.subarray(10 + size);
  }
  return buf;
}

/** Byte length of the MPEG Layer III frame starting at `offset`, or null. */
function frameLength(buf: Buffer, offset: number): number | null {
  if (offset + 4 > buf.length) return null;
  const b1 = buf[offset];
  const b2 = buf[offset + 1];
  const b3 = buf[offset + 2];
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null; // no frame sync
  const versionBits = (b2 >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layerBits = (b2 >> 1) & 0x03; // 1 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null;
  const bitrateIdx = (b3 >> 4) & 0x0f;
  const sampleIdx = (b3 >> 2) & 0x03;
  const padding = (b3 >> 1) & 0x01;
  if (bitrateIdx === 0 || bitrateIdx === 15 || sampleIdx === 3) return null;
  const mpeg1 = versionBits === 3;
  const bitrateKbps = (
    mpeg1
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  )[bitrateIdx];
  const sampleRate = (
    mpeg1 ? [44100, 48000, 32000] : versionBits === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000]
  )[sampleIdx];
  return Math.floor(((mpeg1 ? 144 : 72) * bitrateKbps * 1000) / sampleRate) + padding;
}

/** Byte offsets of each complete MPEG frame; stops at the first unparsable position. */
export function frameOffsets(buf: Buffer): number[] {
  const offsets: number[] = [];
  let pos = 0;
  for (;;) {
    const len = frameLength(buf, pos);
    if (!len || pos + len > buf.length) return offsets;
    offsets.push(pos);
    pos += len;
  }
}

/**
 * Drop a leading Xing/Info/VBRI metadata frame. Every ElevenLabs MP3 starts
 * with one declaring only ITS OWN frame count — after concatenation, players
 * that trust it show the first segment's duration for the whole chapter.
 */
function stripVbrHeaderFrame(buf: Buffer): Buffer {
  const len = frameLength(buf, 0);
  if (!len || len > buf.length) return buf;
  const frame = buf.subarray(0, len);
  for (const tag of ["Xing", "Info", "VBRI"]) {
    const idx = frame.indexOf(tag, 0, "ascii");
    // The tag sits right after the side info: offset 13/21/36 depending on
    // version/channel mode. Anything in that neighbourhood is a header frame.
    if (idx !== -1 && idx <= 40) return buf.subarray(len);
  }
  return buf;
}

/**
 * Concatenate same-format CBR MP3 buffers into one playable file.
 * Frame-level concat of identical codec/samplerate/bitrate streams is safe;
 * ID3 tags and per-piece VBR header frames are stripped so the result is a
 * clean CBR frame stream with a correct estimated duration.
 */
export function concatMp3(buffers: Buffer[]): { data: Buffer; durationSec: number } {
  const parts = buffers.map((b) => stripVbrHeaderFrame(stripId3(b)));
  const data = Buffer.concat(parts);
  return { data, durationSec: (data.length * 8) / BITRATE_BPS };
}

export function estimateMp3DurationSec(bytes: number): number {
  return (bytes * 8) / BITRATE_BPS;
}

/**
 * Playable duration a segment file contributes inside a concatenated chapter
 * (i.e. after the same ID3/VBR-header stripping concatMp3 applies). Used to
 * derive exact read-along timestamps from the cached segment files.
 */
export function segmentAudioDurationSec(buf: Buffer): number {
  return (stripVbrHeaderFrame(stripId3(buf)).length * 8) / BITRATE_BPS;
}

/** Ceiling on any single inserted pause, with headroom over the policy table. */
const MAX_PAUSE_SEC = 1.5;
/** How much of each clip edge to inspect for existing silence (~1 s). */
const EDGE_WINDOW_FRAMES = 40;
/** Extra runway so mpg123 resyncs before the tail window it measures. */
const WARMUP_FRAMES = 8;
/** Samples below this are silence — same treatment as the intro mixer's trim. */
const SILENCE_THRESHOLD = 0.01;

// One encoded silent stream, sliced per request. Prefix slices keep lamejs
// bit-reservoir back-references internal to the slice (frame 0 starts with
// main_data_begin = 0). The next SEGMENT's first frames may reference
// reservoir bytes that now live in silence instead of the previous segment's
// tail — the same already-tolerated glitch class every byte-concat boundary
// has today, except it now lands inside a pause instead of on a transition.
let silentStream: { data: Buffer; offsets: number[] } | null = null;

function getSilentStream(): { data: Buffer; offsets: number[] } {
  if (silentStream) return silentStream;
  const encoder = new Mp3Encoder(1, SAMPLE_RATE, BITRATE_BPS / 1000);
  const block = new Int16Array(FRAME_SAMPLES); // zeros
  const chunks: Buffer[] = [];
  const blocks = Math.ceil(MAX_PAUSE_SEC / FRAME_SEC) + 4;
  for (let i = 0; i < blocks; i++) {
    const out = encoder.encodeBuffer(block);
    if (out.length) chunks.push(Buffer.from(out));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  const data = stripVbrHeaderFrame(stripId3(Buffer.concat(chunks)));
  silentStream = { data, offsets: frameOffsets(data) };
  return silentStream;
}

/**
 * Silent mp3_44100_128-mono frames closest to `targetSec`. `sec` is derived
 * from the byte length — the same math every other duration here uses — so
 * the persisted pause and the stitched file agree exactly.
 */
export function silenceMp3(targetSec: number): { data: Buffer; sec: number } {
  const clamped = Math.min(targetSec, MAX_PAUSE_SEC);
  const wanted = Math.round(clamped / FRAME_SEC);
  if (wanted <= 0) return { data: Buffer.alloc(0), sec: 0 };
  const { data, offsets } = getSilentStream();
  const end = wanted < offsets.length ? offsets[wanted] : data.length;
  const slice = data.subarray(0, end);
  return { data: slice, sec: (slice.length * 8) / BITRATE_BPS };
}

async function decodeMono(buf: Buffer): Promise<Float32Array> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData } = decoder.decode(new Uint8Array(buf));
    return channelData[0] ?? new Float32Array(0);
  } finally {
    decoder.free();
  }
}

/**
 * Lead-in/out silence already present in a clip's edges. ElevenLabs clips
 * carry a variable amount, so inserted pauses subtract it — the perceived gap
 * stays consistent across takes. Only the edge frames are decoded. Any
 * failure reports zero silence (the full target gets inserted) rather than
 * failing the chapter.
 */
export async function measureEdgeSilence(
  buf: Buffer
): Promise<{ leadSec: number; tailSec: number }> {
  try {
    const clean = stripVbrHeaderFrame(stripId3(buf));
    const offsets = frameOffsets(clean);
    if (offsets.length === 0) return { leadSec: 0, tailSec: 0 };
    const cap = EDGE_WINDOW_FRAMES * FRAME_SAMPLES;

    const headEnd =
      offsets.length > EDGE_WINDOW_FRAMES ? offsets[EDGE_WINDOW_FRAMES] : clean.length;
    const head = await decodeMono(clean.subarray(0, headEnd));
    let lead = 0;
    const leadCap = Math.min(head.length, cap);
    while (lead < leadCap && Math.abs(head[lead]) < SILENCE_THRESHOLD) lead++;

    // Decode a little before the tail window and count from the end — the
    // warm-up region's decode accuracy never matters, the cap bounds the count.
    const tailStart = Math.max(0, offsets.length - EDGE_WINDOW_FRAMES - WARMUP_FRAMES);
    const tail = await decodeMono(clean.subarray(offsets[tailStart]));
    let trail = 0;
    const trailCap = Math.min(tail.length, cap);
    while (trail < trailCap && Math.abs(tail[tail.length - 1 - trail]) < SILENCE_THRESHOLD) {
      trail++;
    }

    return { leadSec: lead / SAMPLE_RATE, tailSec: trail / SAMPLE_RATE };
  } catch {
    return { leadSec: 0, tailSec: 0 };
  }
}
