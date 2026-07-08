import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import type { ModelPrefs } from "@/lib/llm-models";
import type { Delivery } from "@/lib/delivery";

export type PipelineStage =
  | "analyzing"
  | "cast_review"
  | "casting"
  | "voice_review"
  | "scripting_sample"
  | "generating_sample"
  | "sample_ready";

export type BookStatus =
  | "parsed"
  | "analyzing"
  | "analyzed"
  | "casting"
  | "cast"
  | "generating"
  | "ready"
  | "error";

export type ChapterStatus =
  | "pending"
  | "scripting"
  | "scripted"
  | "generating"
  | "ready"
  | "stale"
  | "error";

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface NarratorProfile {
  description: string;
  tone: string;
  genderSuggestion: "male" | "female" | "neutral";
}

export interface CharacterProfile {
  gender: "male" | "female" | "nonbinary" | "unknown";
  ageRange: string;
  personality: string;
  speechStyle: string;
  accentHint: string;
  /** Ethnicity/nationality/cultural background as evidenced by the text. */
  heritage?: string;
  /** Physical voice qualities, e.g. "gravelly, deep". */
  voiceTexture?: string;
}

export interface VoiceSettings {
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
}

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author"),
  sourceFileName: text("source_file_name").notNull(),
  status: text("status").$type<BookStatus>().notNull().default("parsed"),
  povType: text("pov_type").$type<"first" | "third">(),
  narratorProfile: text("narrator_profile", { mode: "json" }).$type<NarratorProfile>(),
  // Column default is legacy; new books are inserted with eleven_v3 explicitly
  // (changing the DDL default would force a drizzle table rebuild).
  renderModel: text("render_model").notNull().default("eleven_multilingual_v2"),
  sfxEnabled: integer("sfx_enabled", { mode: "boolean" }).notNull().default(true),
  modelPrefs: text("model_prefs", { mode: "json" }).$type<ModelPrefs>(),
  pipelineStage: text("pipeline_stage").$type<PipelineStage>(),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const chapters = sqliteTable("chapters", {
  id: text("id").primaryKey(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  title: text("title").notNull(),
  text: text("text").notNull(),
  charCount: integer("char_count").notNull(),
  status: text("status").$type<ChapterStatus>().notNull().default("pending"),
  audioPath: text("audio_path"),
  durationSec: real("duration_sec"),
  error: text("error"),
});

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default([]),
  role: text("role").$type<"narrator" | "major" | "minor">().notNull(),
  profile: text("profile", { mode: "json" }).$type<CharacterProfile>().notNull(),
  quotes: text("quotes", { mode: "json" }).$type<string[]>().notNull().default([]),
  dialogueShare: real("dialogue_share").notNull().default(0),
  isNarrator: integer("is_narrator", { mode: "boolean" }).notNull().default(false),
  // Age variants: sibling rows for one person at different life stages,
  // e.g. "Hugo Pitts (child)" / "Hugo Pitts (adult)" share variantGroup "Hugo Pitts"
  variantGroup: text("variant_group"),
  variantLabel: text("variant_label"),
  // User-edited profiles survive re-analysis (exact-name match only)
  profileEdited: integer("profile_edited", { mode: "boolean" }).notNull().default(false),
});

export const voiceAssignments = sqliteTable("voice_assignments", {
  id: text("id").primaryKey(),
  characterId: text("character_id")
    .notNull()
    .unique()
    .references(() => characters.id, { onDelete: "cascade" }),
  voiceId: text("voice_id").notNull(),
  voiceName: text("voice_name").notNull(),
  settings: text("settings", { mode: "json" }).$type<VoiceSettings>().notNull(),
  seed: integer("seed").notNull(),
  rationale: text("rationale"),
  overridden: integer("overridden", { mode: "boolean" }).notNull().default(false),
});

export const segments = sqliteTable("segments", {
  id: text("id").primaryKey(),
  chapterId: text("chapter_id")
    .notNull()
    .references(() => chapters.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  characterId: text("character_id").references(() => characters.id, {
    onDelete: "set null",
  }),
  // "sfx" rows carry a sound-effect prompt in `text` instead of speech
  kind: text("kind").$type<"narration" | "dialogue" | "sfx">().notNull(),
  text: text("text").notNull(),
  textHash: text("text_hash").notNull(),
  audioPath: text("audio_path"),
  flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
  delivery: text("delivery").$type<Delivery>(),
  sfxDurationSec: real("sfx_duration_sec"),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").$type<"analyze" | "cast" | "script" | "generate">().notNull(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  chapterId: text("chapter_id"),
  status: text("status").$type<JobStatus>().notNull().default("running"),
  done: integer("done").notNull().default(0),
  total: integer("total").notNull().default(0),
  charsUsed: integer("chars_used").notNull().default(0),
  note: text("note"),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const voiceCatalogSnapshots = sqliteTable("voice_catalog_snapshots", {
  id: text("id").primaryKey(),
  payload: text("payload", { mode: "json" }).notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).notNull(),
});
