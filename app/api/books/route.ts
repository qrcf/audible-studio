import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { db, books, chapters } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { extractBookText, titleFromFileName, SUPPORTED_EXTENSIONS } from "@/lib/parse/extract";
import { detectChapters } from "@/lib/parse/chapters";

export async function GET() {
  const rows = db.select().from(books).orderBy(desc(books.createdAt)).all();
  return Response.json(rows);
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new AppError("No file provided", "no_file");
    }
    if (file.size > 30 * 1024 * 1024) {
      throw new AppError("File too large (max 30 MB)", "file_too_large");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const text = await extractBookText(buffer, file.name);
    const { chapters: detected, method } = await detectChapters(text, {
      allowLlm: Boolean(process.env.ANTHROPIC_API_KEY),
    });

    const bookId = randomUUID();
    db.transaction((tx) => {
      tx.insert(books)
        .values({
          id: bookId,
          title: titleFromFileName(file.name),
          sourceFileName: file.name,
          status: "parsed",
          // App-level default: the column default predates v3 and changing
          // the DDL would force a table rebuild.
          renderModel: "eleven_v3",
        })
        .run();
      detected.forEach((ch, idx) => {
        tx.insert(chapters)
          .values({
            id: randomUUID(),
            bookId,
            idx,
            title: ch.title,
            text: ch.text,
            charCount: ch.text.length,
          })
          .run();
      });
    });

    return Response.json({
      id: bookId,
      chapterCount: detected.length,
      detectionMethod: method,
      supported: SUPPORTED_EXTENSIONS,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
