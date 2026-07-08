import { generateAuthenticationOptions } from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { getDb, credentials } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { stashChallenge } from "@/lib/auth/session";
import { rpFromRequest } from "@/lib/auth/rp";

export async function POST(req: Request) {
  try {
    const { rpID } = rpFromRequest(req);
    const existing = await getDb().select().from(credentials);
    if (existing.length === 0) {
      throw new AppError("No passkey registered yet — register this device first", "no_credentials", 400);
    }
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: existing.map((c) => ({
        id: c.id,
        transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      })),
      userVerification: "preferred",
    });
    await stashChallenge(options.challenge, "auth");
    return Response.json(options);
  } catch (err) {
    return errorResponse(err);
  }
}
