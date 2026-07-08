import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { getDb, credentials } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { grantSession, takeChallenge } from "@/lib/auth/session";
import { requireSetupSecret, rpFromRequest } from "@/lib/auth/rp";

export async function POST(req: Request) {
  try {
    requireSetupSecret(req);
    const { rpID, origin } = rpFromRequest(req);
    const expectedChallenge = await takeChallenge("reg");
    if (!expectedChallenge) throw new AppError("Challenge expired — try again", "no_challenge", 400);

    const response = (await req.json()) as RegistrationResponseJSON;
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
    if (!verified || !registrationInfo) {
      throw new AppError("Passkey registration failed", "not_verified", 400);
    }

    const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo;
    await getDb().insert(credentials).values({
      id: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    });

    await grantSession();
    return Response.json({ verified: true });
  } catch (err) {
    return errorResponse(err);
  }
}
