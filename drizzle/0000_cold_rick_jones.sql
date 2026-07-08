CREATE TABLE "books" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"source_file_name" text NOT NULL,
	"status" text DEFAULT 'parsed' NOT NULL,
	"pov_type" text,
	"narrator_profile" jsonb,
	"render_model" text DEFAULT 'eleven_v3' NOT NULL,
	"sfx_enabled" boolean DEFAULT true NOT NULL,
	"model_prefs" jsonb,
	"pipeline_stage" text,
	"error" text,
	"active_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"idx" integer NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"char_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"audio_path" text,
	"duration_sec" double precision,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"role" text NOT NULL,
	"profile" jsonb NOT NULL,
	"quotes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dialogue_share" double precision DEFAULT 0 NOT NULL,
	"is_narrator" boolean DEFAULT false NOT NULL,
	"variant_group" text,
	"variant_label" text,
	"profile_edited" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"book_id" text NOT NULL,
	"chapter_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"chars_used" integer DEFAULT 0 NOT NULL,
	"note" text,
	"error" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" text PRIMARY KEY NOT NULL,
	"chapter_id" text NOT NULL,
	"idx" integer NOT NULL,
	"character_id" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"audio_path" text,
	"duration_sec" double precision,
	"flagged" boolean DEFAULT false NOT NULL,
	"delivery" text,
	"sfx_duration_sec" double precision
);
--> statement-breakpoint
CREATE TABLE "voice_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"character_id" text NOT NULL,
	"voice_id" text NOT NULL,
	"voice_name" text NOT NULL,
	"settings" jsonb NOT NULL,
	"seed" integer NOT NULL,
	"rationale" text,
	"overridden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "voice_assignments_character_id_unique" UNIQUE("character_id")
);
--> statement-breakpoint
CREATE TABLE "voice_catalog_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_assignments" ADD CONSTRAINT "voice_assignments_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapters_book_id_idx" ON "chapters" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "characters_book_id_idx" ON "characters" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "jobs_book_status_idx" ON "jobs" USING btree ("book_id","status");--> statement-breakpoint
CREATE INDEX "segments_chapter_id_idx" ON "segments" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "segments_character_id_idx" ON "segments" USING btree ("character_id");