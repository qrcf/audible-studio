import { desc, eq, sql } from "drizzle-orm";
import { BookOpen } from "lucide-react";
import { db, books, chapters, characters } from "@/lib/db";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BookCard } from "@/components/book-card";
import { UploadDialog } from "@/components/upload-dialog";

export const dynamic = "force-dynamic";

export default function LibraryPage() {
  const rows = db
    .select({
      book: books,
      chapterCount: sql<number>`count(distinct ${chapters.id})`,
      charCount: sql<number>`coalesce(sum(${chapters.charCount}), 0)`,
    })
    .from(books)
    .leftJoin(chapters, eq(chapters.bookId, books.id))
    .groupBy(books.id)
    .orderBy(desc(books.createdAt))
    .all();

  const characterCounts = new Map(
    db
      .select({ bookId: characters.bookId, n: sql<number>`count(*)` })
      .from(characters)
      .groupBy(characters.bookId)
      .all()
      .map((r) => [r.bookId, r.n])
  );

  const missingKeys = (["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"] as const).filter(
    (k) => !process.env[k]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="text-sm text-muted-foreground">
            Upload a book and turn it into a multi-voice audiobook.
          </p>
        </div>
        <UploadDialog />
      </div>

      {missingKeys.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Setup needed</AlertTitle>
          <AlertDescription>
            Missing {missingKeys.join(" and ")} — add{" "}
            {missingKeys.length > 1 ? "them" : "it"} to{" "}
            <code className="font-mono">.env.local</code> and restart the dev server.
            Character analysis needs Anthropic; voices and audio need ElevenLabs.
          </AlertDescription>
        </Alert>
      )}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-24 text-center">
          <BookOpen className="h-10 w-10 text-muted-foreground" />
          <div>
            <p className="font-medium">No books yet</p>
            <p className="text-sm text-muted-foreground">
              Upload a .docx, .pdf, or .txt to get started.
            </p>
          </div>
          <UploadDialog />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ book, chapterCount, charCount }) => (
            <BookCard
              key={book.id}
              book={book}
              chapterCount={chapterCount}
              charCount={charCount}
              characterCount={characterCounts.get(book.id) ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
