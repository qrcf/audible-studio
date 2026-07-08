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

// The account's own voices (~32 premades) only cover a few accents. The real
// range — every accent — lives in the shared voice library, and those voices
// are usable directly in TTS by their id (no "add to account" step needed;
// probed live). We pull a broad, trending-sorted slice for accent coverage.
const SHARED_PAGES = 8; // × 100 = up to 800 voices across accents

async function fetchCatalog(): Promise<VoiceProfile[]> {
  const client = new ElevenLabsClient({ apiKey: requireEnv("ELEVENLABS_API_KEY") });

  // Shared library — English-language voices only (which still spans every
  // English accent: Indian, Nigerian, Irish, Southern-US, …), trending first
  // for quality, paginated for accent breadth.
  const shared: unknown[] = [];
  for (let page = 0; page < SHARED_PAGES; page++) {
    const res = await client.voices.getShared({
      pageSize: 100,
      page,
      sort: "trending",
      language: "en",
    });
    shared.push(...(res.voices ?? []));
    if (!res.hasMore) break;
  }

  // The account's own voices (premades + any the user cloned/added).
  const account: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.voices.search({
      pageSize: 100,
      ...(pageToken ? { nextPageToken: pageToken } : {}),
    });
    account.push(...page.voices);
    pageToken = page.hasMore ? (page.nextPageToken ?? undefined) : undefined;
  } while (pageToken);

  // Merge, dedup by id; the account's own labels win over the shared copy.
  const byId = new Map<string, VoiceProfile>();
  for (const v of shared) {
    const p = normalizeSharedVoice(v);
    if (p.id) byId.set(p.id, p);
  }
  for (const v of account) {
    const p = normalizeVoice(v);
    if (p.id) byId.set(p.id, p);
  }
  const voices = [...byId.values()];
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

/**
 * Live search of the FULL shared library (thousands of voices) by
 * accent/gender/query — used by casting so the model can find any accent, not
 * just the cached slice. English-only. Age is filtered by the caller.
 */
export async function searchSharedVoices(q: {
  gender?: string;
  accent?: string;
  query?: string;
  limit?: number;
}): Promise<VoiceProfile[]> {
  const client = new ElevenLabsClient({ apiKey: requireEnv("ELEVENLABS_API_KEY") });
  const res = await client.voices.getShared({
    pageSize: Math.min(q.limit ?? 20, 30),
    sort: "trending",
    language: "en",
    ...(q.gender && q.gender !== "neutral" ? { gender: q.gender } : {}),
    ...(q.accent ? { accent: q.accent } : {}),
    ...(q.query ? { search: q.query } : {}),
  });
  return (res.voices ?? []).map(normalizeSharedVoice).filter((v) => v.id);
}

// Account voices (/v2/voices): metadata lives in free-form `labels`.
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

// Shared-library voices (/v1/shared-voices): flat fields. Read both camel and
// snake casing so we don't depend on the SDK's field-name transform.
function normalizeSharedVoice(v: unknown): VoiceProfile {
  const s = v as Record<string, unknown>;
  const str = (...keys: string[]): string | null => {
    for (const k of keys) if (typeof s[k] === "string" && s[k]) return s[k] as string;
    return null;
  };
  const id = str("voiceId", "voice_id");
  return {
    id: id ?? "",
    name: str("name") ?? id ?? "",
    category: str("category") ?? "shared",
    description: str("description"),
    gender: str("gender"),
    age: str("age"),
    accent: str("accent"),
    descriptive: str("descriptive") ?? str("description"),
    useCase: str("useCase", "use_case"),
    previewUrl: str("previewUrl", "preview_url"),
  };
}
