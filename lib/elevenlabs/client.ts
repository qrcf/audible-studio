import { ElevenLabsError, requireEnv } from "@/lib/errors";

/**
 * Global concurrency gate matching the ElevenLabs plan cap
 * (Free 2, Starter 3, Creator 5, Pro 10). Exceeding it 429s.
 */
class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private slots: number) {}
  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.slots++;
  }
}

const globalForEleven = globalThis as unknown as { __elevenSemaphore?: Semaphore };

function semaphore(): Semaphore {
  if (!globalForEleven.__elevenSemaphore) {
    const n = Math.max(1, Number(process.env.ELEVEN_CONCURRENCY) || 2);
    globalForEleven.__elevenSemaphore = new Semaphore(n);
  }
  return globalForEleven.__elevenSemaphore;
}

const MAX_ATTEMPTS = 5;

/**
 * Semaphore-gated POST to the ElevenLabs API, retrying 429/5xx with
 * exponential backoff. Returns the OK response; throws ElevenLabsError
 * otherwise. Raw fetch (not the SDK) so callers can read response headers
 * like `request-id`.
 */
export async function elevenFetch(pathAndQuery: string, body: unknown): Promise<Response> {
  const apiKey = requireEnv("ELEVENLABS_API_KEY");
  let lastError: ElevenLabsError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, backoff));
    }

    await semaphore().acquire();
    try {
      const res = await fetch(`https://api.elevenlabs.io${pathAndQuery}`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;

      lastError = await toElevenError(res);
      if (!lastError.retryable) throw lastError;
    } finally {
      semaphore().release();
    }
  }

  throw (
    lastError ?? new ElevenLabsError("ElevenLabs request failed after retries", "unknown", 500, false)
  );
}

async function toElevenError(res: Response): Promise<ElevenLabsError> {
  let code = `http_${res.status}`;
  let message = `ElevenLabs error (HTTP ${res.status})`;
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (typeof detail === "string") message = detail;
    else if (detail?.status) {
      code = detail.status;
      message = detail.message ?? message;
    }
  } catch {
    // non-JSON body
  }

  if (res.status === 401) {
    return new ElevenLabsError(
      "ElevenLabs rejected the API key — check ELEVENLABS_API_KEY in .env.local.",
      "invalid_api_key",
      401,
      false
    );
  }
  if (code === "quota_exceeded") {
    return new ElevenLabsError(
      "ElevenLabs credits exhausted for this billing cycle. Upgrade the plan or wait for the reset.",
      "quota_exceeded",
      402,
      false
    );
  }
  if (code === "voice_not_found") {
    return new ElevenLabsError(
      "This voice no longer exists in your ElevenLabs account — pick a different voice.",
      "voice_not_found",
      404,
      false
    );
  }
  const retryable = res.status === 429 || res.status >= 500;
  return new ElevenLabsError(message, code, res.status, retryable);
}
