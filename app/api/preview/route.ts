import { createHash } from "node:crypto";
import { z } from "zod";
import { ttsConvert, DEFAULT_SETTINGS } from "@/lib/elevenlabs/tts";
import { errorResponse, AppError } from "@/lib/errors";
import { audioExists, previewAudioPath, readAudio, writeAudio } from "@/lib/paths";

// Previews always render on flash (half the credits); plenty for auditioning voices.
const PREVIEW_MODEL = "eleven_flash_v2_5";
const MAX_PREVIEW_CHARS = 300;

const bodySchema = z.object({
  voiceId: z.string().min(1),
  text: z.string().min(1),
  settings: z
    .object({
      stability: z.number().min(0).max(1),
      similarityBoost: z.number().min(0).max(1),
      style: z.number().min(0).max(1),
      speed: z.number().min(0.7).max(1.2),
    })
    .optional(),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) throw new AppError("Invalid preview request", "bad_request");

    const { voiceId } = parsed.data;
    const settings = parsed.data.settings ?? DEFAULT_SETTINGS;
    const text = parsed.data.text.slice(0, MAX_PREVIEW_CHARS);

    const cacheKey = createHash("sha256")
      .update(JSON.stringify([voiceId, text, settings, PREVIEW_MODEL]))
      .digest("hex");
    const relPath = previewAudioPath(cacheKey);

    let audio: Buffer;
    if (audioExists(relPath)) {
      audio = readAudio(relPath);
    } else {
      const result = await ttsConvert({ voiceId, text, modelId: PREVIEW_MODEL, settings });
      audio = result.audio;
      writeAudio(relPath, audio);
    }

    return new Response(new Uint8Array(audio), {
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(audio.length),
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
