import { elevenFetch } from "./client";
import { OUTPUT_FORMAT } from "./tts";

/** Cheesy audiobook-open bed for the book intro. */
export const INTRO_MUSIC_PROMPT =
  "warm, cheesy, triumphant orchestral audiobook intro fanfare — a short, uplifting flourish of strings and horns that resolves cleanly";

/**
 * Generate a music clip as CBR 128k MP3 — same format as speech/sfx segments,
 * so byte-concat into chapter audio stays valid. `lengthMs` is the requested
 * clip length (the API returns close to it).
 */
export async function generateMusic(prompt: string, lengthMs: number): Promise<Buffer> {
  const res = await elevenFetch(`/v1/music?output_format=${OUTPUT_FORMAT}`, {
    prompt,
    music_length_ms: lengthMs,
  });
  return Buffer.from(await res.arrayBuffer());
}
