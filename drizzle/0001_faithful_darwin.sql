CREATE TABLE "book_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "book_shares_book_id_unique" UNIQUE("book_id"),
	CONSTRAINT "book_shares_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "book_shares" ADD CONSTRAINT "book_shares_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;