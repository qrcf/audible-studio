import fs from "node:fs";
import path from "node:path";

// Local-disk storage adapter. Swap this module out for Blob/S3 when deploying.
export const AUDIO_ROOT = path.join(process.cwd(), "data", "audio");

export function segmentAudioPath(bookId: string, cacheKey: string): string {
  return path.join("segments", bookId, `${cacheKey}.mp3`);
}

export function chapterAudioPath(bookId: string, idx: number): string {
  return path.join("chapters", bookId, `chapter-${String(idx).padStart(3, "0")}.mp3`);
}

export function previewAudioPath(cacheKey: string): string {
  return path.join("previews", `${cacheKey}.mp3`);
}

export function audioAbsPath(relPath: string): string {
  const abs = path.resolve(AUDIO_ROOT, relPath);
  if (!abs.startsWith(path.resolve(AUDIO_ROOT) + path.sep)) {
    throw new Error("Invalid audio path");
  }
  return abs;
}

export function audioExists(relPath: string): boolean {
  return fs.existsSync(audioAbsPath(relPath));
}

export function readAudio(relPath: string): Buffer {
  return fs.readFileSync(audioAbsPath(relPath));
}

export function writeAudio(relPath: string, data: Buffer): void {
  const abs = audioAbsPath(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

export function deleteBookAudio(bookId: string): void {
  for (const dir of ["segments", "chapters"]) {
    fs.rmSync(path.join(AUDIO_ROOT, dir, bookId), { recursive: true, force: true });
  }
}
