import type { VoiceSettings } from "@/lib/db/schema";
import { isV3, snapStabilityV3 } from "@/lib/delivery";
import { elevenFetch } from "./client";

export const OUTPUT_FORMAT = "mp3_44100_128"; // CBR 128kbps — safe to concat, all plans

// Conservative per-request character limits (docs: mv2 10k, flash/turbo 40k, v3 5k)
const MODEL_LIMITS: Record<string, number> = {
  eleven_multilingual_v2: 9_500,
  eleven_flash_v2_5: 38_000,
  eleven_turbo_v2_5: 38_000,
  eleven_v3: 4_500,
};

export function modelCharLimit(modelId: string): number {
  return MODEL_LIMITS[modelId] ?? 9_500;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speed: 1.0,
};

export const NARRATOR_SETTINGS: VoiceSettings = {
  stability: 0.65,
  similarityBoost: 0.75,
  style: 0,
  speed: 1.0,
};

export interface TtsRequest {
  voiceId: string;
  text: string;
  modelId: string;
  settings: VoiceSettings;
  seed?: number;
  /** Tail of the preceding text — conditions prosody so segments flow. */
  previousText?: string;
  /** Head of the following text. */
  nextText?: string;
  /** Up to 3 request IDs from earlier same-voice segments for stitching. */
  previousRequestIds?: string[];
}

export interface TtsResult {
  audio: Buffer;
  requestId: string | null;
}

export async function ttsConvert(req: TtsRequest): Promise<TtsResult> {
  const v3 = isV3(req.modelId);
  const res = await elevenFetch(
    `/v1/text-to-speech/${req.voiceId}?output_format=${OUTPUT_FORMAT}`,
    {
      text: req.text,
      model_id: req.modelId,
      // v3's stability is semantically discrete (Creative/Natural/Robust) —
      // snap it; the API accepts the remaining fields (probed live).
      voice_settings: {
        stability: v3 ? snapStabilityV3(req.settings.stability) : req.settings.stability,
        similarity_boost: req.settings.similarityBoost,
        style: req.settings.style,
        speed: req.settings.speed,
        use_speaker_boost: true,
      },
      ...(req.previousText ? { previous_text: req.previousText } : {}),
      ...(req.nextText ? { next_text: req.nextText } : {}),
      ...(!v3 && req.previousRequestIds?.length
        ? { previous_request_ids: req.previousRequestIds.slice(-3) }
        : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(v3 ? {} : { apply_text_normalization: "auto" }),
    }
  );

  const audio = Buffer.from(await res.arrayBuffer());
  return { audio, requestId: res.headers.get("request-id") };
}

/** Split text at sentence boundaries so each piece fits the model limit. */
export function splitForModel(text: string, modelId: string): string[] {
  const limit = modelCharLimit(modelId);
  if (text.length <= limit) return [text];

  const sentences = text.split(/(?<=[.!?…"'”’])\s+/);
  const pieces: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + s.length + 1 > limit) {
      pieces.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
    while (current.length > limit) {
      pieces.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
