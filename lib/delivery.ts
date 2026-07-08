import type { VoiceSettings } from "@/lib/db/schema";

// Client-safe (no node imports) — ScriptSheet and listen-tab import from here.

export const DELIVERY_VALUES = [
  "whisper",
  "shout",
  "angry",
  "fearful",
  "sad",
  "excited",
  "tender",
  "sarcastic",
  "urgent",
  "weary",
  "amused",
  "solemn",
] as const;

export type Delivery = (typeof DELIVERY_VALUES)[number];

export function isDelivery(v: unknown): v is Delivery {
  return typeof v === "string" && (DELIVERY_VALUES as readonly string[]).includes(v);
}

export const isV3 = (modelId: string): boolean => modelId === "eleven_v3";

/** Eleven v3 accepts only discrete stability values (Creative/Natural/Robust). */
export function snapStabilityV3(stability: number): 0 | 0.5 | 1 {
  if (stability < 0.25) return 0;
  if (stability < 0.75) return 0.5;
  return 1;
}

// v3 renders inflection as inline audio tags prepended to the line.
const V3_TAGS: Record<Delivery, string> = {
  whisper: "[whispers]",
  shout: "[shouting]",
  angry: "[angry]",
  fearful: "[fearful]",
  sad: "[sad]",
  excited: "[excited]",
  tender: "[gently]",
  sarcastic: "[sarcastic]",
  urgent: "[urgently]",
  weary: "[tired]",
  amused: "[amused]",
  solemn: "[solemnly]",
};

export function deliveryTag(d: Delivery | null): string {
  return d ? `${V3_TAGS[d]} ` : "";
}

// v2 models can't read tags — nudge the character's voice settings instead.
const V2_DELTAS: Record<Delivery, { stability: number; style: number; speed: number }> = {
  whisper: { stability: 0.05, style: 0.1, speed: -0.05 },
  shout: { stability: -0.2, style: 0.3, speed: 0.03 },
  angry: { stability: -0.2, style: 0.3, speed: 0.02 },
  fearful: { stability: -0.15, style: 0.25, speed: 0.04 },
  sad: { stability: -0.1, style: 0.2, speed: -0.05 },
  excited: { stability: -0.2, style: 0.25, speed: 0.05 },
  tender: { stability: -0.05, style: 0.15, speed: -0.03 },
  sarcastic: { stability: -0.1, style: 0.25, speed: 0 },
  urgent: { stability: -0.15, style: 0.2, speed: 0.05 },
  weary: { stability: -0.05, style: 0.15, speed: -0.05 },
  amused: { stability: -0.1, style: 0.2, speed: 0.02 },
  solemn: { stability: 0.05, style: 0.1, speed: -0.04 },
};

// Results round to 2dp: the adjusted settings feed the JSON-hashed audio cache
// key, and float drift (0.65-0.2 = 0.45000000000000007) would poison it.
const r2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Per-line settings for v2 renders. Null delivery returns the object
 * UNCHANGED (same reference) so existing cache keys stay byte-identical.
 */
export function applyDeliveryToSettings(s: VoiceSettings, d: Delivery | null): VoiceSettings {
  if (!d) return s;
  const delta = V2_DELTAS[d];
  return {
    ...s,
    stability: r2(clamp(s.stability + delta.stability, 0, 1)),
    // High style degrades v2 output — deltas never push past 0.4, but a
    // user's own higher baseline is respected.
    style: r2(clamp(s.style + delta.style, 0, Math.max(0.4, s.style))),
    speed: r2(clamp(s.speed + delta.speed, 0.85, 1.1)),
  };
}
