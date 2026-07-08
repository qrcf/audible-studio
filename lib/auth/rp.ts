import { timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";

export const RP_NAME = "Audiobook Studio";
export const USER_NAME = "quinn";

/**
 * Relying-party identity. Passkeys are origin-bound, so this derives from the
 * request by default (works on localhost and prod alike); pin explicitly with
 * WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN in production.
 */
export function rpFromRequest(req: Request): { rpID: string; origin: string } {
  const url = new URL(req.url);
  return {
    rpID: process.env.WEBAUTHN_RP_ID ?? url.hostname,
    origin: process.env.WEBAUTHN_ORIGIN ?? url.origin,
  };
}

/** Registration is invite-only: callers must present the setup secret. */
export function requireSetupSecret(req: Request): void {
  const expected = process.env.SETUP_SECRET;
  const provided = req.headers.get("x-setup-secret") ?? "";
  const ok =
    Boolean(expected) &&
    provided.length === expected!.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected!));
  if (!ok) throw new AppError("Invalid setup secret", "forbidden", 403);
}
