import { eq } from "drizzle-orm";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { getDb, credentials } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { grantSession, takeChallenge } from "@/lib/auth/session";
import { rpFromRequest } from "@/lib/auth/rp";

export async function POST(req: Request) {
  try {
    const { rpID, origin } = rpFromRequest(req);
    const expectedChallenge = await takeChallenge("auth");
    if (!expectedChallenge) throw new AppError("Challenge expired — try again", "no_challenge", 400);

    const response = (await req.json()) as AuthenticationResponseJSON;
    const db = getDb();
    const [cred] = await db
      .select()
      .from(credentials)
      .where(eq(credentials.id, response.id))
      .limit(1);
    if (!cred) throw new AppError("Unknown passkey", "unknown_credential", 401);

    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.id,
        publicKey: isoBase64URL.toBuffer(cred.publicKey),
        counter: cred.counter,
        transports: (cred.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
    });
    if (!verified) throw new AppError("Sign-in failed", "not_verified", 401);

    await db
      .update(credentials)
      .set({ counter: authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(credentials.id, cred.id));

    await grantSession();
    return Response.json({ verified: true });
  } catch (err) {
    return errorResponse(err);
  }
}
