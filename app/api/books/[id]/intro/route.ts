import { ensureBookIntro } from "@/lib/intro";
import { errorResponse, AppError } from "@/lib/errors";

/**
 * (Re)generate the book's standalone intro section — themed music bed + the
 * narrator reading "{Title}, by {Author}." Regenerates from scratch so it
 * picks up edited title/author or a recast narrator.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await ensureBookIntro(id, true);
    if (!result) {
      throw new AppError("Cast the narrator's voice before generating the intro", "no_narrator");
    }
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
}
