import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "session";
export const CHALLENGE_COOKIE = "webauthn_challenge";
// Read-only share-link viewers get a separate cookie so redeeming a link never
// clobbers the owner's session. Kept short-lived so a revoked link stops
// working soon (the token is a stateless JWT — see grantViewerSession).
export const SHARE_COOKIE = "share_session";
const SESSION_DAYS = 30;
const SHARE_DAYS = 1;
const CHALLENGE_MINUTES = 5;

export type AuthContext = { role: "owner" } | { role: "viewer"; bookId: string };

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (≥32 chars)");
  return new TextEncoder().encode(s);
}

const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export async function grantSession(): Promise<void> {
  const token = await new SignJWT({ sub: "quinn" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
  (await cookies()).set(SESSION_COOKIE, token, {
    ...cookieBase,
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * Mints a read-only viewer session for one book. The claims (role/bookId) are
 * self-contained so pages and the proxy can authorize without a DB read; the
 * cookie is short-lived because a stateless JWT can't be revoked server-side.
 */
export async function grantViewerSession(bookId: string, shareId: string): Promise<void> {
  const token = await new SignJWT({ role: "viewer", bookId, shareId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SHARE_DAYS}d`)
    .sign(secret());
  (await cookies()).set(SHARE_COOKIE, token, {
    ...cookieBase,
    maxAge: SHARE_DAYS * 24 * 60 * 60,
  });
}

export async function clearViewerSession(): Promise<void> {
  (await cookies()).delete(SHARE_COOKIE);
}

/**
 * True when the caller is a share-link viewer scoped to a *different* book —
 * used by routes whose bookId isn't in the URL (so the proxy can't scope them)
 * to reject cross-book reads. Owner and normal (cookie-less, proxy-gated)
 * callers are never blocked.
 */
export async function viewerDeniedForBook(bookId: string): Promise<boolean> {
  const ctx = await readAuthContext();
  return ctx?.role === "viewer" && ctx.bookId !== bookId;
}

/**
 * Resolves who is making a server request: the owner (valid `session`), else a
 * read-only viewer (valid `share_session`), else null. Owner takes precedence.
 */
export async function readAuthContext(): Promise<AuthContext | null> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE)?.value;
  if (session) {
    try {
      await jwtVerify(session, secret());
      return { role: "owner" };
    } catch {
      // fall through to viewer check
    }
  }
  const share = store.get(SHARE_COOKIE)?.value;
  if (share) {
    try {
      const { payload } = await jwtVerify(share, secret());
      if (payload.role === "viewer" && typeof payload.bookId === "string") {
        return { role: "viewer", bookId: payload.bookId };
      }
    } catch {
      // invalid/expired
    }
  }
  return null;
}

/**
 * WebAuthn challenges round-trip through a short-lived signed cookie instead
 * of server state — serverless instances share nothing between the options
 * and verify requests.
 */
export async function stashChallenge(challenge: string, typ: "reg" | "auth"): Promise<void> {
  const token = await new SignJWT({ challenge, typ })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_MINUTES}m`)
    .sign(secret());
  (await cookies()).set(CHALLENGE_COOKIE, token, {
    ...cookieBase,
    maxAge: CHALLENGE_MINUTES * 60,
  });
}

export async function takeChallenge(typ: "reg" | "auth"): Promise<string | null> {
  const store = await cookies();
  const token = store.get(CHALLENGE_COOKIE)?.value;
  store.delete(CHALLENGE_COOKIE);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.typ !== typ || typeof payload.challenge !== "string") return null;
    return payload.challenge;
  } catch {
    return null;
  }
}
