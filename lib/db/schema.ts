import {
  pgTable,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  bigint,
} from "drizzle-orm/pg-core";
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

export const books = pgTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author"),
  sourceFileName: text("source_file_name").notNull(),
  status: text("status").$type<BookStatus>().notNull().default("parsed"),
  povType: text("pov_type").$type<"first" | "third">(),
  narratorProfile: jsonb("narrator_profile").$type<NarratorProfile>(),
  renderModel: text("render_model").notNull().default("eleven_v3"),
  sfxEnabled: boolean("sfx_enabled").notNull().default(true),
  modelPrefs: jsonb("model_prefs").$type<ModelPrefs>(),
  pipelineStage: text("pipeline_stage").$type<PipelineStage>(),
  error: text("error"),
  // Workflow run driving the current book-wide operation, if any
  activeRunId: text("active_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const chapters = pgTable(
  "chapters",
  {
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
    durationSec: doublePrecision("duration_sec"),
    error: text("error"),
  },
  (t) => [index("chapters_book_id_idx").on(t.bookId)]
);

export const characters = pgTable(
  "characters",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    role: text("role").$type<"narrator" | "major" | "minor">().notNull(),
    profile: jsonb("profile").$type<CharacterProfile>().notNull(),
    quotes: jsonb("quotes").$type<string[]>().notNull().default([]),
    dialogueShare: doublePrecision("dialogue_share").notNull().default(0),
    isNarrator: boolean("is_narrator").notNull().default(false),
    // Age variants: sibling rows for one person at different life stages,
    // e.g. "Hugo Pitts (child)" / "Hugo Pitts (adult)" share variantGroup "Hugo Pitts"
    variantGroup: text("variant_group"),
    variantLabel: text("variant_label"),
    // User-edited profiles survive re-analysis (exact-name match only)
    profileEdited: boolean("profile_edited").notNull().default(false),
  },
  (t) => [index("characters_book_id_idx").on(t.bookId)]
);

export const voiceAssignments = pgTable("voice_assignments", {
  id: text("id").primaryKey(),
  characterId: text("character_id")
    .notNull()
    .unique()
    .references(() => characters.id, { onDelete: "cascade" }),
  voiceId: text("voice_id").notNull(),
  voiceName: text("voice_name").notNull(),
  settings: jsonb("settings").$type<VoiceSettings>().notNull(),
  seed: integer("seed").notNull(),
  rationale: text("rationale"),
  overridden: boolean("overridden").notNull().default(false),
});

export const segments = pgTable(
  "segments",
  {
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
    // Exact playback length, captured from the rendered buffer at generation
    // time (read-along timing reads this instead of re-measuring audio)
    durationSec: doublePrecision("duration_sec"),
    flagged: boolean("flagged").notNull().default(false),
    delivery: text("delivery").$type<Delivery>(),
    sfxDurationSec: doublePrecision("sfx_duration_sec"),
  },
  (t) => [
    index("segments_chapter_id_idx").on(t.chapterId),
    index("segments_character_id_idx").on(t.characterId),
  ]
);

export const jobs = pgTable(
  "jobs",
  {
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
    // Workflow run executing this job, for cancellation/reconciliation
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("jobs_book_status_idx").on(t.bookId, t.status)]
);

export const voiceCatalogSnapshots = pgTable("voice_catalog_snapshots", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull(),
});

// WebAuthn passkeys for the single app user
export const credentials = pgTable("credentials", {
  // base64url credential ID from the authenticator
  id: text("id").primaryKey(),
  // base64url-encoded COSE public key
  publicKey: text("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: jsonb("transports").$type<string[]>(),
  deviceType: text("device_type"),
  backedUp: boolean("backed_up").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
});
