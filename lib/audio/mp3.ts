const BITRATE_BPS = 128_000; // OUTPUT_FORMAT mp3_44100_128 is constant-bitrate

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

/** Sample rate (Hz) declared by the first MPEG frame, or null if unreadable. */
export function firstFrameSampleRate(buf: Buffer): number | null {
  const b = stripId3(buf);
  // Scan for the first valid frame sync (some streams have a few junk bytes).
  for (let off = 0; off < Math.min(b.length - 4, 4096); off++) {
    if (frameLength(b, off) === null) continue;
    const b2 = b[off + 1];
    const b3 = b[off + 2];
    const versionBits = (b2 >> 3) & 0x03;
    const sampleIdx = (b3 >> 2) & 0x03;
    return (
      versionBits === 3
        ? [44100, 48000, 32000]
        : versionBits === 2
          ? [22050, 24000, 16000]
          : [11025, 12000, 8000]
    )[sampleIdx];
  }
  return null;
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
