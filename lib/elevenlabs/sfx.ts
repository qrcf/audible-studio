import { elevenFetch } from "./client";
import { OUTPUT_FORMAT } from "./tts";

export interface SfxRequest {
  text: string;
  durationSec: number;
  /** 0-1; higher follows the prompt more literally. */
  promptInfluence?: number;
}

/**
 * Generate a sound effect as CBR 128k MP3 — same format as speech segments,
 * so byte-concat into chapter audio stays valid. Duration is always explicit:
 * ~11 credits/sec vs ~100 credits for auto-duration.
 */
export async function soundEffect(req: SfxRequest): Promise<Buffer> {
  const res = await elevenFetch(`/v1/sound-generation?output_format=${OUTPUT_FORMAT}`, {
    text: req.text,
    duration_seconds: req.durationSec,
    prompt_influence: req.promptInfluence ?? 0.3,
    model_id: "eleven_text_to_sound_v2",
    loop: false,
  });
  return Buffer.from(await res.arrayBuffer());
}
