import { errorResponse } from "@/lib/errors";
import { cancelJob } from "@/lib/jobs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const cancelled = cancelJob(id);
    return Response.json({ cancelled });
  } catch (err) {
    return errorResponse(err);
  }
}
