import { isAudioPathname, presignAudioUrl } from "@/lib/storage";
import { readAuthContext } from "@/lib/auth/session";

/**
 * Audio playback/download: hands the browser a short-lived presigned CDN URL
 * for the private blob. The CDN serves Range requests (seeking) and CORS-
 * readable responses, so <audio>, fetch-based downloads, and the client-side
 * zip all work through this one redirect.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await params;
  const pathname = parts.join("/");
  if (!isAudioPathname(pathname)) return new Response("Bad path", { status: 400 });

  // Share viewers may only reach their own book's audio. Blob paths are
  // book-scoped (segments/<bookId>/…, chapters/<bookId>/…, intro/<bookId>/…);
  // previews aren't, so viewers are denied those outright.
  const ctx = await readAuthContext();
  if (ctx?.role === "viewer") {
    const [prefix, bookId] = parts;
    const scoped =
      ["segments", "chapters", "intro"].includes(prefix) && bookId === ctx.bookId;
    if (!scoped) return new Response("Forbidden", { status: 403 });
  }

  const url = await presignAudioUrl(pathname);
  return new Response(null, {
    status: 302,
    headers: { location: url, "cache-control": "private, no-store" },
  });
}
