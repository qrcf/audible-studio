import { getCredits } from "@/lib/elevenlabs/credits";
import { errorResponse } from "@/lib/errors";

export async function GET() {
  try {
    return Response.json(await getCredits());
  } catch (err) {
    return errorResponse(err);
  }
}
