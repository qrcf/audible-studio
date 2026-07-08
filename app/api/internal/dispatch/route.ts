import { dispatchAll } from "@/lib/queue";
import { errorResponse } from "@/lib/errors";

/**
 * Internal trigger the chapter workflows ping on completion so the bounded
 * queue keeps draining server-side even with no book page open. Guarded by a
 * shared secret when DISPATCH_SECRET is set (skipped in local dev if unset).
 */
export async function POST(req: Request) {
  try {
    const secret = process.env.DISPATCH_SECRET;
    if (secret && req.headers.get("x-dispatch-secret") !== secret) {
      return new Response("forbidden", { status: 403 });
    }
    await dispatchAll();
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
