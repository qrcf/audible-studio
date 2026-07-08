import path from "node:path";
import { stripEmphasis } from "@/lib/analysis/clean";
import { AppError } from "@/lib/errors";

export const SUPPORTED_EXTENSIONS = [".txt", ".md", ".docx", ".pdf"];

export async function extractBookText(buffer: Buffer, fileName: string): Promise<string> {
  const ext = path.extname(fileName).toLowerCase();
  let raw: string;

  if (ext === ".txt" || ext === ".md") {
    raw = buffer.toString("utf-8");
  } else if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    raw = result.value;
  } else if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    raw = text;
  } else if (ext === ".doc") {
    throw new AppError(
      "Legacy .doc files aren't supported — save the file as .docx and try again.",
      "unsupported_file"
    );
  } else {
    throw new AppError(
      `Unsupported file type "${ext}". Upload a .docx, .pdf, or .txt file.`,
      "unsupported_file"
    );
  }

  const text = normalize(raw);
  if (text.length < 100) {
    throw new AppError(
      "Couldn't extract readable text from this file (it may be a scanned/image-only PDF).",
      "empty_extraction"
    );
  }
  return text;
}

function normalize(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Gutenberg-style _emphasis_ would otherwise leak into TTS text
  return stripEmphasis(text);
}

export function titleFromFileName(fileName: string): string {
  return path
    .basename(fileName, path.extname(fileName))
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
