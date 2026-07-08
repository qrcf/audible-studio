import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, books, chapters } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { readBlobIfExists, deleteBlobs } from "@/lib/storage";
import { extractBookText, titleFromFileName, SUPPORTED_EXTENSIONS } from "@/lib/parse/extract";
import { detectChapters } from "@/lib/parse/chapters";

export async function GET() {
  const rows = await getDb().select().from(books).orderBy(desc(books.createdAt));
  return Response.json(rows);
}

const bodySchema = z.object({
  uploadPathname: z.string().min(1),
  fileName: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) throw new AppError("Invalid upload request", "bad_request");
    const { uploadPathname, fileName } = parsed.data;
    if (!uploadPathname.startsWith("uploads/") || uploadPathname.includes("..")) {
      throw new AppError("Invalid upload path", "bad_request");
    }

    const buffer = await readBlobIfExists(uploadPathname);
    if (!buffer) throw new AppError("Upload not found — try again", "no_file");

    try {
      if (buffer.length > 30 * 1024 * 1024) {
        throw new AppError("File too large (max 30 MB)", "file_too_large");
      }

      const text = await extractBookText(buffer, fileName);
      const { chapters: detected, method } = await detectChapters(text, {
        allowLlm: Boolean(process.env.ANTHROPIC_API_KEY),
      });

      const bookId = randomUUID();
      const db = getDb();
      await db.transaction(async (tx) => {
        await tx.insert(books).values({
          id: bookId,
          title: titleFromFileName(fileName),
          sourceFileName: fileName,
          status: "parsed",
          renderModel: "eleven_v3",
        });
        const rows = detected.map((ch, idx) => ({
          id: randomUUID(),
          bookId,
          idx,
          title: ch.title,
          text: ch.text,
          charCount: ch.text.length,
        }));
        for (let i = 0; i < rows.length; i += 20) {
          await tx.insert(chapters).values(rows.slice(i, i + 20));
        }
      });

      return Response.json({
        id: bookId,
        chapterCount: detected.length,
        detectionMethod: method,
        supported: SUPPORTED_EXTENSIONS,
      });
    } finally {
      // The source file is transient — remove it whether or not parsing worked
      await deleteBlobs(uploadPathname).catch(() => {});
    }
  } catch (err) {
    return errorResponse(err);
  }
}
