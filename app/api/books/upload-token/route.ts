import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { errorResponse, AppError } from "@/lib/errors";

// Book uploads go client → Blob directly (serverless request bodies cap at
// 4.5 MB); this route only mints the scoped upload token. The client then
// POSTs the resulting pathname to /api/books for parsing.

const ALLOWED_EXT = [".txt", ".md", ".docx", ".pdf"];
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("uploads/")) {
          throw new AppError("Bad upload path", "bad_request");
        }
        const ext = pathname.slice(pathname.lastIndexOf(".")).toLowerCase();
        if (!ALLOWED_EXT.includes(ext)) {
          throw new AppError("Unsupported file type", "bad_type");
        }
        return {
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true, // transient, unguessable
          tokenPayload: "",
        };
      },
      onUploadCompleted: async () => {
        // Intentionally empty: this callback never fires on localhost, so the
        // client drives the parse step explicitly via POST /api/books.
      },
    });
    return Response.json(json);
  } catch (err) {
    return errorResponse(err);
  }
}
