import {
  BlobNotFoundError,
  del,
  get,
  head,
  list,
  put,
  issueSignedToken,
  presignUrl,
} from "@vercel/blob";

// Vercel Blob storage adapter (PRIVATE store). DB `audioPath` columns hold
// blob pathnames; the browser reaches audio via /api/audio/<pathname>, which
// redirects to a short-lived presigned CDN URL (Range + CORS verified live).

export function segmentAudioPath(bookId: string, cacheKey: string): string {
  return `segments/${bookId}/${cacheKey}.mp3`;
}

// Chapter blobs are content-versioned: overwriting an existing pathname can
// serve stale CDN/browser caches for up to a minute, so regeneration writes a
// new pathname and deletes the old blob once the DB row points at it.
export function chapterAudioPath(bookId: string, idx: number, contentHash: string): string {
  return `chapters/${bookId}/chapter-${String(idx).padStart(3, "0")}-${contentHash}.mp3`;
}

export function previewAudioPath(cacheKey: string): string {
  return `previews/${cacheKey}.mp3`;
}

const AUDIO_PREFIXES = ["segments/", "chapters/", "previews/"];

export function isAudioPathname(pathname: string): boolean {
  return (
    AUDIO_PREFIXES.some((p) => pathname.startsWith(p)) &&
    pathname.endsWith(".mp3") &&
    !pathname.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

/** Buffer if the blob exists, else null — one round trip for cache checks. */
export async function readBlobIfExists(pathname: string): Promise<Buffer | null> {
  const result = await get(pathname, { access: "private" });
  if (!result) return null;
  return Buffer.from(await new Response(result.stream).arrayBuffer());
}

export async function readAudio(pathname: string): Promise<Buffer> {
  const buf = await readBlobIfExists(pathname);
  if (!buf) throw new Error(`Audio blob not found: ${pathname}`);
  return buf;
}

export async function audioExists(pathname: string): Promise<boolean> {
  try {
    await head(pathname);
    return true;
  } catch (err) {
    if (err instanceof BlobNotFoundError) return false;
    throw err;
  }
}

/** Returns the pathname (what audioPath columns store). */
export async function writeAudio(pathname: string, data: Buffer): Promise<string> {
  await put(pathname, data, {
    access: "private",
    contentType: "audio/mpeg",
    addRandomSuffix: false, // deterministic cache paths
    allowOverwrite: true, // content-addressed: same pathname ⇒ identical bytes
  });
  return pathname;
}

/** Free and never throws on missing blobs (network errors still throw). */
export async function deleteBlobs(pathnames: string | string[]): Promise<void> {
  await del(pathnames);
}

export async function deleteBookAudio(bookId: string): Promise<void> {
  for (const prefix of [`segments/${bookId}/`, `chapters/${bookId}/`, `intro/${bookId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      if (page.blobs.length > 0) await del(page.blobs.map((b) => b.pathname));
      cursor = page.cursor;
    } while (cursor);
  }
}

// One wildcard read delegation per process (~1h validity), refreshed with
// margin; presignUrl itself is a local HMAC — no network per URL.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const globalForStorage = globalThis as unknown as {
  __blobReadToken?: Awaited<ReturnType<typeof issueSignedToken>>;
};

async function readDelegation() {
  const cached = globalForStorage.__blobReadToken;
  if (cached && cached.validUntil - Date.now() > TOKEN_REFRESH_MARGIN_MS) return cached;
  const token = await issueSignedToken({ pathname: "*", operations: ["get"] });
  globalForStorage.__blobReadToken = token;
  return token;
}

/** Short-lived CDN URL for streaming/downloading a private blob. */
export async function presignAudioUrl(pathname: string): Promise<string> {
  const token = await readDelegation();
  const { presignedUrl } = await presignUrl(token, {
    operation: "get",
    pathname,
    access: "private",
  });
  return presignedUrl;
}
