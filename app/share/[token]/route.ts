import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, bookShares } from "@/lib/db";
import { grantViewerSession } from "@/lib/auth/session";

/**
 * Redeems a share link: validates the token, mints a read-only viewer session
 * scoped to the book, and redirects into the normal book page. The viewer stays
 * un-signed-in — the `share_session` cookie is their only credential.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [share] = await getDb()
    .select({ id: bookShares.id, bookId: bookShares.bookId })
    .from(bookShares)
    .where(eq(bookShares.token, token))
    .limit(1);

  if (!share) {
    return NextResponse.redirect(new URL("/share/invalid", req.url));
  }

  await grantViewerSession(share.bookId, share.id);
  await getDb()
    .update(bookShares)
    .set({ lastViewedAt: new Date() })
    .where(eq(bookShares.id, share.id));

  return NextResponse.redirect(new URL(`/books/${share.bookId}`, req.url));
}
