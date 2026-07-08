import { randomUUID, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, books, bookShares } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { readAuthContext } from "@/lib/auth/session";

type Ctx = { params: Promise<{ id: string }> };

// Share links are owner-only. The proxy already blocks viewers from non-GET
// here, but a viewer could otherwise GET the link for their own book, so every
// method re-checks that the caller is the owner.
async function requireOwner(): Promise<void> {
  const ctx = await readAuthContext();
  if (ctx?.role !== "owner") throw new AppError("Owner only", "forbidden", 403);
}

async function currentToken(bookId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ token: bookShares.token })
    .from(bookShares)
    .where(eq(bookShares.bookId, bookId))
    .limit(1);
  return row?.token ?? null;
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    await requireOwner();
    const { id } = await params;
    return Response.json({ token: await currentToken(id) });
  } catch (err) {
    return errorResponse(err);
  }
}

// Generate or regenerate the link: a fresh token replaces any existing one
// (one link per book), which invalidates the old URL.
export async function POST(_req: Request, { params }: Ctx) {
  try {
    await requireOwner();
    const { id } = await params;
    const db = getDb();
    const [book] = await db.select({ id: books.id }).from(books).where(eq(books.id, id)).limit(1);
    if (!book) throw new AppError("Book not found", "not_found", 404);

    const token = randomBytes(24).toString("base64url");
    await db
      .insert(bookShares)
      .values({ id: randomUUID(), bookId: id, token })
      .onConflictDoUpdate({
        target: bookShares.bookId,
        set: { token, lastViewedAt: null },
      });
    return Response.json({ token });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    await requireOwner();
    const { id } = await params;
    await getDb().delete(bookShares).where(eq(bookShares.bookId, id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
