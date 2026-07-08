import { and, eq, inArray } from "drizzle-orm";
import { getDb, books, chapters, characters, segments, voiceAssignments } from "@/lib/db";
import type { VoiceSettings } from "@/lib/db/schema";
import {
  applyDeliveryToSettings,
  deliveryTag,
  isDelivery,
  isV3,
  snapStabilityV3,
} from "@/lib/delivery";
import { estimateSfxCredits } from "@/lib/format";

export interface Assignment {
  voiceId: string;
  settings: VoiceSettings;
  seed: number;
}

export const CONTEXT_CHARS = 250; // previous_text / next_text conditioning window
export const DEFAULT_SFX_SECONDS = 3;

/**
 * Rough per-segment work size for the progress bar / ETA. TTS time scales with
 * characters synthesized, so speech weighs its text length; SFX (fixed-duration
 * generation) weighs its credit estimate — matching how charsUsed accounts for
 * it. Cache-independent by design: a cached segment still counts its full size.
 */
export function segmentGenWeight(seg: {
  kind: "narration" | "dialogue" | "sfx";
  text: string;
  sfxDurationSec: number | null;
}): number {
  return seg.kind === "sfx"
    ? estimateSfxCredits(seg.sfxDurationSec ?? DEFAULT_SFX_SECONDS)
    : seg.text.length;
}

/**
 * What actually gets sent to TTS for a speech segment: v3 renders delivery as
 * an inline audio tag (with stability snapped to its discrete values); v2
 * models render it as small voice-setting nudges. Null delivery on a v2 model
 * returns the settings object untouched, keeping cache keys byte-identical to
 * pre-delivery renders.
 */
export function renderPlan(
  seg: { text: string; delivery: string | null },
  settings: VoiceSettings,
  renderModel: string
): { renderedText: string; settings: VoiceSettings } {
  const delivery = isDelivery(seg.delivery) ? seg.delivery : null;
  if (isV3(renderModel)) {
    return {
      renderedText: deliveryTag(delivery) + seg.text,
      settings: { ...settings, stability: snapStabilityV3(settings.stability) },
    };
  }
  return { renderedText: seg.text, settings: applyDeliveryToSettings(settings, delivery) };
}

/** Map every segment's characterId (null = narrator) to its cast voice. */
export async function getAssignmentResolver(bookId: string): Promise<{
  resolve: (characterId: string | null) => Assignment | null;
  missingNames: (segs: { characterId: string | null }[]) => string[];
}> {
  const rows = await getDb()
    .select({
      characterId: characters.id,
      name: characters.name,
      isNarrator: characters.isNarrator,
      voiceId: voiceAssignments.voiceId,
      settings: voiceAssignments.settings,
      seed: voiceAssignments.seed,
    })
    .from(characters)
    .leftJoin(voiceAssignments, eq(voiceAssignments.characterId, characters.id))
    .where(eq(characters.bookId, bookId));

  const byId = new Map<string, (typeof rows)[number]>();
  let narrator: (typeof rows)[number] | undefined;
  for (const r of rows) {
    byId.set(r.characterId, r);
    if (r.isNarrator) narrator = r;
  }

  const toAssignment = (r?: (typeof rows)[number]): Assignment | null =>
    r?.voiceId && r.settings && r.seed !== null
      ? { voiceId: r.voiceId, settings: r.settings, seed: r.seed ?? 0 }
      : null;

  return {
    resolve: (characterId) =>
      toAssignment(characterId ? byId.get(characterId) : narrator) ?? toAssignment(narrator),
    missingNames: (segs) => {
      const missing = new Set<string>();
      if (!toAssignment(narrator)) missing.add("Narrator");
      for (const s of segs) {
        if (s.characterId && !toAssignment(byId.get(s.characterId))) {
          // falls back to narrator, but if narrator is also unassigned it's fatal
          if (!toAssignment(narrator)) missing.add(byId.get(s.characterId)?.name ?? "?");
        }
      }
      return [...missing];
    },
  };
}

export async function chapterIdToBookId(chapterId: string): Promise<string> {
  const rows = await getDb()
    .select({ bookId: chapters.bookId })
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .limit(1);
  return rows[0]?.bookId ?? "";
}

export async function refreshBookStatus(bookId: string): Promise<void> {
  if (!bookId) return;
  const db = getDb();
  const statuses = (
    await db.select({ status: chapters.status }).from(chapters).where(eq(chapters.bookId, bookId))
  ).map((c) => c.status);
  if (statuses.length === 0) return;

  let status: "ready" | "generating" | "cast" | null = null;
  if (statuses.every((s) => s === "ready")) status = "ready";
  else if (statuses.some((s) => s === "generating" || s === "scripting")) status = "generating";
  else {
    const [book] = await db
      .select({ status: books.status })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);
    if (book?.status === "generating") status = "cast"; // finished but not everything is ready
  }
  if (status) {
    await db.update(books).set({ status }).where(eq(books.id, bookId));
  }
}

/** Mark ready chapters containing this character's segments as stale (voice changed). */
export async function markStaleForCharacter(
  characterId: string,
  bookId: string,
  isNarrator: boolean
): Promise<number> {
  const db = getDb();
  const chapterRows = (
    await db
      .select({ id: chapters.id, status: chapters.status })
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
  ).filter((c) => c.status === "ready" || c.status === "stale");
  if (chapterRows.length === 0) return 0;

  const segRows = await db
    .select({ chapterId: segments.chapterId, characterId: segments.characterId })
    .from(segments)
    .where(inArray(segments.chapterId, chapterRows.map((c) => c.id)));
  const affected = new Set(
    segRows
      .filter((s) => (isNarrator ? s.characterId === null : s.characterId === characterId))
      .map((s) => s.chapterId)
  );

  const toMark = chapterRows.filter((c) => c.status === "ready" && affected.has(c.id));
  if (toMark.length > 0) {
    await db
      .update(chapters)
      .set({ status: "stale" })
      .where(
        and(
          inArray(chapters.id, toMark.map((c) => c.id)),
          eq(chapters.status, "ready")
        )
      );
  }
  return toMark.length;
}
