import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { eq } from "drizzle-orm";
import { getDb, voiceCatalogSnapshots } from "@/lib/db";
import { requireEnv } from "@/lib/errors";

export interface VoiceProfile {
  id: string;
  name: string;
  category: string;
  description: string | null;
  gender: string | null;
  age: string | null;
  accent: string | null;
  descriptive: string | null;
  useCase: string | null;
  previewUrl: string | null;
}

interface CatalogCache {
  voices: VoiceProfile[];
  fetchedAt: number;
}

const TTL_MS = 60 * 60 * 1000;
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const globalForCatalog = globalThis as unknown as { __voiceCatalog?: CatalogCache };

/**
 * Memory (1h TTL) → DB snapshot (<24h; instant after a server restart, with a
 * background refresh when it's older than the TTL) → ElevenLabs network fetch.
 */
export async function getVoiceCatalog(force = false): Promise<VoiceProfile[]> {
  const cached = globalForCatalog.__voiceCatalog;
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.voices;
  }

  if (!force) {
    const [snapshot] = await getDb()
      .select()
      .from(voiceCatalogSnapshots)
      .where(eq(voiceCatalogSnapshots.id, "latest"))
      .limit(1);
    if (snapshot) {
      const age = Date.now() - snapshot.fetchedAt.getTime();
      if (age < SNAPSHOT_MAX_AGE_MS) {
        const voices = snapshot.payload as VoiceProfile[];
        globalForCatalog.__voiceCatalog = { voices, fetchedAt: snapshot.fetchedAt.getTime() };
        if (age > TTL_MS) {
          void fetchCatalog().catch((err) =>
            console.warn("Background voice catalog refresh failed:", err)
          );
        }
        return voices;
      }
    }
  }

  return fetchCatalog();
}

async function fetchCatalog(): Promise<VoiceProfile[]> {
  const client = new ElevenLabsClient({ apiKey: requireEnv("ELEVENLABS_API_KEY") });
  const raw: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.voices.search({
      pageSize: 100,
      ...(pageToken ? { nextPageToken: pageToken } : {}),
    });
    raw.push(...page.voices);
    pageToken = page.hasMore ? (page.nextPageToken ?? undefined) : undefined;
  } while (pageToken);

  const voices = raw.map(normalizeVoice);
  globalForCatalog.__voiceCatalog = { voices, fetchedAt: Date.now() };

  await getDb()
    .insert(voiceCatalogSnapshots)
    .values({ id: "latest", payload: voices, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: voiceCatalogSnapshots.id,
      set: { payload: voices, fetchedAt: new Date() },
    });

  return voices;
}

// Labels are free-form key/value pairs; key spellings vary across voices.
function normalizeVoice(v: unknown): VoiceProfile {
  const voice = v as {
    voiceId: string;
    name?: string | null;
    category?: string | null;
    description?: string | null;
    labels?: Record<string, string | undefined> | null;
    previewUrl?: string | null;
  };
  const labels = voice.labels ?? {};
  return {
    id: voice.voiceId,
    name: voice.name ?? voice.voiceId,
    category: voice.category ?? "unknown",
    description: voice.description ?? null,
    gender: labels["gender"] ?? null,
    age: labels["age"] ?? null,
    accent: labels["accent"] ?? null,
    descriptive: labels["descriptive"] ?? labels["description"] ?? null,
    useCase: labels["use_case"] ?? labels["usecase"] ?? null,
    previewUrl: voice.previewUrl ?? null,
  };
}
