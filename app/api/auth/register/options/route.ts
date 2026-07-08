import { generateRegistrationOptions } from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { getDb, credentials } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { stashChallenge } from "@/lib/auth/session";
import { RP_NAME, USER_NAME, requireSetupSecret, rpFromRequest } from "@/lib/auth/rp";

export async function POST(req: Request) {
  try {
    requireSetupSecret(req);
    const { rpID } = rpFromRequest(req);
    const existing = await getDb().select().from(credentials);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: USER_NAME,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    await stashChallenge(options.challenge, "reg");
    return Response.json(options);
  } catch (err) {
    return errorResponse(err);
  }
}
