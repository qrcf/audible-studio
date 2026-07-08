import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "session";
export const CHALLENGE_COOKIE = "webauthn_challenge";
const SESSION_DAYS = 30;
const CHALLENGE_MINUTES = 5;

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
