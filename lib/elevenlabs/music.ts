import { elevenFetch } from "./client";
import { OUTPUT_FORMAT } from "./tts";

/** Fallback intro bed when a book-specific prompt can't be derived. */
export const INTRO_MUSIC_PROMPT =
  "short, warm orchestral audiobook intro flourish that resolves cleanly, no vocals";

/**
 * Generate an instrumental clip as MP3. We pin `music_v1`, which is natively
 * 44.1 kHz, so it matches our speech output (mp3_44100_128) and can be
 * concatenated with a spoken line into one clean single-rate section. (The
 * newer music_v2 renders at 48 kHz; mixing that with 44.1 kHz speech makes a
 * player lock to one rate and play the other pitch-shifted + staticky.)
 * `lengthMs` is the requested clip length (the API returns close to it).
 */
export async function generateMusic(prompt: string, lengthMs: number): Promise<Buffer> {
  const res = await elevenFetch(`/v1/music?output_format=${OUTPUT_FORMAT}`, {
    prompt,
    music_length_ms: lengthMs,
    model_id: "music_v1",
  });
  return Buffer.from(await res.arrayBuffer());
}
