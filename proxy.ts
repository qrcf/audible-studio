import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

// Single-user passkey gate: everything except the login flow requires the
// session cookie minted by /api/auth/*.
const PUBLIC_PREFIXES = ["/login", "/api/auth/"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get("session")?.value;
  const secret = process.env.SESSION_SECRET;
  if (token && secret) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret));
      return NextResponse.next();
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

export const config = {
  // Excludes Next internals/static assets and the Workflow DevKit's internal
  // endpoints (/.well-known/workflow/* authenticates its own invocations via
  // Vercel Queues; blocking it wedges every workflow run).
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|\\.well-known/workflow/).*)"],
};
