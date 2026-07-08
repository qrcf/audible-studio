import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

// Single-user passkey gate: everything except the login flow and share-link
// redemption requires the session cookie minted by /api/auth/*. Share-link
// viewers carry a separate `share_session` cookie (see viewerGate).
// `/api/internal/` carries no session (it's the queue's server-to-server
// dispatch ping); it authenticates itself with DISPATCH_SECRET in-route.
const PUBLIC_PREFIXES = ["/login", "/api/auth/", "/share/", "/api/internal/"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const secretStr = process.env.SESSION_SECRET;
  const secret = secretStr ? new TextEncoder().encode(secretStr) : null;

  // Owner: a valid `session` cookie grants full access (unchanged).
  const sessionToken = request.cookies.get("session")?.value;
  if (sessionToken && secret) {
    try {
      await jwtVerify(sessionToken, secret);
      return NextResponse.next();
    } catch {
      // invalid/expired — try a viewer session, then fall through
    }
  }

  // Viewer: a valid `share_session` cookie grants read-only access to one book.
  const shareToken = request.cookies.get("share_session")?.value;
  if (shareToken && secret) {
    try {
      const { payload } = await jwtVerify(shareToken, secret);
      if (payload.role === "viewer" && typeof payload.bookId === "string") {
        return viewerGate(request, payload.bookId);
      }
    } catch {
      // invalid/expired — fall through to challenge
    }
  }

  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

/**
 * Read-only, single-book access for share-link viewers. Two invariants:
 *  - read-only: every mutation in the app is a non-GET method, so blocking
 *    non-GET here blocks all editing regardless of any per-route/UI logic;
 *  - book scope: only paths carrying this viewer's bookId are allowed. Routes
 *    whose bookId isn't in the URL (chapters/*) re-check it against the DB.
 */
function viewerGate(request: NextRequest, bookId: string) {
  const { pathname } = request.nextUrl;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "read-only share" }, { status: 403 });
  }

  // Send viewers to the one book they can see instead of the library.
  if (pathname === "/") {
    return NextResponse.redirect(new URL(`/books/${bookId}`, request.url));
  }

  const allowed =
    // The book page itself
    pathname === `/books/${bookId}` ||
    // Book-scoped read APIs (book fetch, progress poll) — but never share mgmt
    ((pathname === `/api/books/${bookId}` || pathname.startsWith(`/api/books/${bookId}/`)) &&
      !pathname.startsWith(`/api/books/${bookId}/share`)) ||
    // Audio blobs are pathname-scoped by book (segments/<id>/…, chapters/<id>/…)
    pathname.startsWith(`/api/audio/segments/${bookId}/`) ||
    pathname.startsWith(`/api/audio/chapters/${bookId}/`) ||
    // Chapter-keyed GET reads (segments, readalong) re-check bookId in-route
    pathname.startsWith("/api/chapters/") ||
    // Global voice catalog carries no book data
    pathname === "/api/voices";

  if (allowed) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return new NextResponse("Not available on this share link", { status: 403 });
}

export const config = {
  // Excludes Next internals/static assets and the Workflow DevKit's internal
  // endpoints (/.well-known/workflow/* authenticates its own invocations via
  // Vercel Queues; blocking it wedges every workflow run).
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|\\.well-known/workflow/).*)"],
};
