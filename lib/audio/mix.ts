import { MPEGDecoder } from "mpg123-decoder";
import { Mp3Encoder } from "@breezystack/lamejs";

// The intro is the one place we combine streams that differ in channel mode
// (stereo music vs mono speech) — byte-level concat can't express that, so the
// section is decoded, mixed as PCM, and re-encoded into one homogeneous
// stereo CBR stream (same rate/bitrate as OUTPUT_FORMAT, so the byte-length
// duration math elsewhere still holds).
const MIX_RATE = 44100;
const MIX_KBPS = 128;

/** When the title line enters over the music bed. */
const VOICE_START_MS = 1800;
/** Music level under the voice (~ -10 dB). */
const DUCK_GAIN = 0.32;
/** Duck ramp length; the duck leads the voice by one ramp. */
const RAMP_MS = 300;
/** Music restores this long after the voice ends. */
const DUCK_HOLD_MS = 150;
/** Fade applied to the music's final moments so a hard clip end stays clean. */
const TAIL_FADE_MS = 250;
/** Silence kept after the voice when it outlasts the music. */
const OUTRO_PAD_MS = 600;

/** Samples below this are treated as silence when trimming the voice clip. */
const SILENCE_THRESHOLD = 0.01;
const TRIM_HEAD_PAD_MS = 50;
const TRIM_TAIL_PAD_MS = 100;

const ms = (n: number) => Math.round((n / 1000) * MIX_RATE);

interface Pcm {
  channelData: Float32Array[];
  sampleRate: number;
}

async function decodeMp3(buf: Buffer): Promise<Pcm> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = decoder.decode(new Uint8Array(buf));
    if (!samplesDecoded || channelData.length === 0) throw new Error("MP3 decoded to 0 samples");
    return { channelData, sampleRate };
  } finally {
    decoder.free();
  }
}

/** Linear-interpolation resample — plenty for an 8s intro bed. */
function resample(pcm: Pcm): Float32Array[] {
  if (pcm.sampleRate === MIX_RATE) return pcm.channelData;
  const ratio = pcm.sampleRate / MIX_RATE;
  return pcm.channelData.map((src) => {
    const out = new Float32Array(Math.floor(src.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      out[i] = src[i0] * (1 - frac) + (src[Math.min(i0 + 1, src.length - 1)] ?? 0) * frac;
    }
    return out;
  });
}

function downmixMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/** TTS clips carry variable lead-in/out silence; trim so the title lands on cue. */
function trimSilence(pcm: Float32Array): Float32Array {
  let start = 0;
  let end = pcm.length;
  while (start < end && Math.abs(pcm[start]) < SILENCE_THRESHOLD) start++;
  while (end > start && Math.abs(pcm[end - 1]) < SILENCE_THRESHOLD) end--;
  if (start >= end) throw new Error("voice clip is all silence");
  start = Math.max(0, start - ms(TRIM_HEAD_PAD_MS));
  end = Math.min(pcm.length, end + ms(TRIM_TAIL_PAD_MS));
  return pcm.subarray(start, end);
}

function encodeMp3Stereo(left: Float32Array, right: Float32Array, gain: number): Buffer {
  const encoder = new Mp3Encoder(2, MIX_RATE, MIX_KBPS);
  const BLOCK = 1152; // one MPEG1 Layer III frame
  const l16 = new Int16Array(BLOCK);
  const r16 = new Int16Array(BLOCK);
  const toI16 = (s: number) => Math.max(-32768, Math.min(32767, Math.round(s * gain * 32767)));
  const chunks: Buffer[] = [];
  for (let off = 0; off < left.length; off += BLOCK) {
    const n = Math.min(BLOCK, left.length - off);
    for (let i = 0; i < n; i++) {
      l16[i] = toI16(left[off + i]);
      r16[i] = toI16(right[off + i]);
    }
    const data = encoder.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n));
    if (data.length) chunks.push(Buffer.from(data));
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}

/**
 * Mix the intro: the spoken title enters at VOICE_START_MS over the music bed,
 * which ducks under it and then restores to resolve on its own ending. Inputs
 * may disagree in sample rate or channel mode; the output is always one
 * 44.1 kHz stereo CBR 128k stream.
 */
export async function mixIntro(music: Buffer, voice: Buffer): Promise<Buffer> {
  const [musicPcm, voicePcm] = await Promise.all([decodeMp3(music), decodeMp3(voice)]);

  const musicCh = resample(musicPcm);
  const musicL = musicCh[0];
  const musicR = musicCh[1] ?? musicCh[0];
  const voiceMono = trimSilence(downmixMono(resample(voicePcm)));

  const voiceStart = ms(VOICE_START_MS);
  const voiceEnd = voiceStart + voiceMono.length;
  const total = Math.max(musicL.length, voiceEnd + ms(OUTRO_PAD_MS));
  const left = new Float32Array(total);
  const right = new Float32Array(total);

  const ramp = ms(RAMP_MS);
  const duckStart = voiceStart - ramp;
  const duckEnd = voiceEnd + ms(DUCK_HOLD_MS);
  const tailFade = ms(TAIL_FADE_MS);
  for (let i = 0; i < musicL.length; i++) {
    let gain = 1;
    if (i >= duckStart && i < duckStart + ramp) gain = 1 - (1 - DUCK_GAIN) * ((i - duckStart) / ramp);
    else if (i >= duckStart + ramp && i < duckEnd) gain = DUCK_GAIN;
    else if (i >= duckEnd && i < duckEnd + ramp) gain = DUCK_GAIN + (1 - DUCK_GAIN) * ((i - duckEnd) / ramp);
    const remaining = musicL.length - i;
    if (remaining < tailFade) gain *= remaining / tailFade;
    left[i] = musicL[i] * gain;
    right[i] = musicR[i] * gain;
  }
  for (let i = 0; i < voiceMono.length; i++) {
    left[voiceStart + i] += voiceMono[i];
    right[voiceStart + i] += voiceMono[i];
  }

  let peak = 0;
  for (let i = 0; i < total; i++) {
    const mag = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (mag > peak) peak = mag;
  }
  const gain = peak > 0.98 ? 0.98 / peak : 1;

  return encodeMp3Stereo(left, right, gain);
}
