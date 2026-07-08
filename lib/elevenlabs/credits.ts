import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { requireEnv } from "@/lib/errors";

export interface CreditsInfo {
  used: number;
  limit: number;
  tier: string;
  resetAt: number | null;
}

export async function getCredits(): Promise<CreditsInfo> {
  const client = new ElevenLabsClient({ apiKey: requireEnv("ELEVENLABS_API_KEY") });
  const sub = await client.user.subscription.get();
  return {
    used: sub.characterCount,
    limit: sub.characterLimit,
    tier: sub.tier,
    resetAt: sub.nextCharacterCountResetUnix ?? null,
  };
}
