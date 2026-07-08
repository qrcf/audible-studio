import { getVoiceCatalog } from "@/lib/elevenlabs/catalog";
import { errorResponse } from "@/lib/errors";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const voices = await getVoiceCatalog(force);
    return Response.json(voices);
  } catch (err) {
    return errorResponse(err);
  }
}
