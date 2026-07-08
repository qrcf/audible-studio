import fs from "node:fs";
import { audioAbsPath } from "@/lib/paths";

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await params;
  let abs: string;
  try {
    abs = audioAbsPath(parts.join("/"));
  } catch {
    return new Response("Bad path", { status: 400 });
  }
  if (!fs.existsSync(abs)) return new Response("Not found", { status: 404 });

  const { size } = fs.statSync(abs);
  const range = req.headers.get("range");
  const baseHeaders: Record<string, string> = {
    "content-type": "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  };

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
      if (start <= end && start < size) {
        const stream = fs.createReadStream(abs, { start, end });
        return new Response(stream as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...baseHeaders,
            "content-range": `bytes ${start}-${end}/${size}`,
            "content-length": String(end - start + 1),
          },
        });
      }
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }
  }

  const stream = fs.createReadStream(abs);
  return new Response(stream as unknown as ReadableStream, {
    headers: { ...baseHeaders, "content-length": String(size) },
  });
}
