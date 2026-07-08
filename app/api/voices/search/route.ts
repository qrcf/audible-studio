import { getVoiceCatalog, searchSharedVoices } from "@/lib/elevenlabs/catalog";
import { errorResponse } from "@/lib/errors";

/**
 * Live voice search over the FULL English shared library (thousands of
 * voices) — the picker can't cache them all, so it queries this as the user
 * types. Account/premade + cached matches come first, then live results.
 */
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) return Response.json([]);

    const [live, cached] = await Promise.all([
      searchSharedVoices({ query: q, limit: 40 }),
      getVoiceCatalog(),
    ]);
    const ql = q.toLowerCase();
    const local = cached.filter((v) =>
      [v.name, v.gender, v.age, v.accent, v.descriptive, v.description].some((f) =>
        f?.toLowerCase().includes(ql)
      )
    );

    const byId = new Map<string, (typeof cached)[number]>();
    for (const v of [...local, ...live]) if (v.id && !byId.has(v.id)) byId.set(v.id, v);
    return Response.json([...byId.values()].slice(0, 80));
  } catch (err) {
    return errorResponse(err);
  }
}
