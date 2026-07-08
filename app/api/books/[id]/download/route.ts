import { asc, eq } from "drizzle-orm";
import JSZip from "jszip";
import { db, books, chapters } from "@/lib/db";
import { audioExists, readAudio } from "@/lib/paths";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const book = db.select().from(books).where(eq(books.id, id)).get();
  if (!book) return new Response("Not found", { status: 404 });

  const rows = db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, id))
    .orderBy(asc(chapters.idx))
    .all()
    .filter((c) => c.audioPath && audioExists(c.audioPath));

  if (rows.length === 0) {
    return Response.json({ error: "No generated audio yet" }, { status: 400 });
  }

  const zip = new JSZip();
  for (const ch of rows) {
    const safeTitle = ch.title.replace(/[^\w\s-]/g, "").trim().slice(0, 60) || `Chapter ${ch.idx + 1}`;
    zip.file(`${String(ch.idx + 1).padStart(2, "0")} - ${safeTitle}.mp3`, readAudio(ch.audioPath!));
  }
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });

  const safeBook = book.title.replace(/[^\w\s-]/g, "").trim().slice(0, 80) || "audiobook";
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${safeBook}.zip"`,
      "content-length": String(data.length),
    },
  });
}
