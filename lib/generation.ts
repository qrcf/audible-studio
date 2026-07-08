import { createHash } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { db, books, chapters, characters, segments, voiceAssignments } from "@/lib/db";
import type { VoiceSettings } from "@/lib/db/schema";
import { ttsConvert, splitForModel } from "@/lib/elevenlabs/tts";
import { soundEffect } from "@/lib/elevenlabs/sfx";
import {
  applyDeliveryToSettings,
  deliveryTag,
  isDelivery,
  isV3,
  snapStabilityV3,
} from "@/lib/delivery";
import { estimateSfxCredits } from "@/lib/format";
import { concatMp3 } from "@/lib/audio/mp3";
import {
  audioExists,
  chapterAudioPath,
  readAudio,
  segmentAudioPath,
  writeAudio,
} from "@/lib/paths";
import {
  assertNotCancelled,
  completeJob,
  createJob,
  failJob,
  jobStatus,
  noteJob,
  setJobTotal,
  tickJob,
  withHeartbeat,
} from "@/lib/jobs";
import { AppError, JobCancelledError } from "@/lib/errors";
import { scriptChapter } from "@/lib/analysis/scripting";

interface Assignment {
  voiceId: string;
  settings: VoiceSettings;
  seed: number;
}

const CONTEXT_CHARS = 250; // previous_text / next_text conditioning window
const DEFAULT_SFX_SECONDS = 3;

/**
 * What actually gets sent to TTS for a speech segment: v3 renders delivery as
 * an inline audio tag (with stability snapped to its discrete values); v2
 * models render it as small voice-setting nudges. Null delivery on a v2 model
 * returns the settings object untouched, keeping cache keys byte-identical to
 * pre-delivery renders.
 */
function renderPlan(
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
export function getAssignmentResolver(bookId: string): {
  resolve: (characterId: string | null) => Assignment | null;
  missingNames: (segs: { characterId: string | null }[]) => string[];
} {
  const rows = db
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
    .where(eq(characters.bookId, bookId))
    .all();

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

export async function generateChapter(chapterId: string, jobId: string): Promise<void> {
  try {
    const chapter = db.select().from(chapters).where(eq(chapters.id, chapterId)).get();
    if (!chapter) throw new Error("Chapter not found");
    const book = db.select().from(books).where(eq(books.id, chapter.bookId)).get();
    if (!book) throw new Error("Book not found");

    const segs = db
      .select()
      .from(segments)
      .where(eq(segments.chapterId, chapterId))
      .orderBy(asc(segments.idx))
      .all();
    if (segs.length === 0) throw new AppError("Chapter has no script yet", "not_scripted");

    const { resolve, missingNames } = getAssignmentResolver(chapter.bookId);
    const missing = missingNames(segs.filter((s) => s.kind !== "sfx"));
    if (missing.length > 0) {
      throw new AppError(`No voice assigned for: ${missing.join(", ")}. Cast voices first.`, "uncast");
    }
    const nameById = new Map(
      db
        .select({ id: characters.id, name: characters.name })
        .from(characters)
        .where(eq(characters.bookId, chapter.bookId))
        .all()
        .map((c) => [c.id, c.name])
    );

    setJobTotal(jobId, segs.length);
    db.update(chapters)
      .set({ status: "generating", error: null })
      .where(eq(chapters.id, chapterId))
      .run();

    const chapterBuffers: Buffer[] = [];
    // Stitching chain: request IDs from immediately preceding fresh same-voice audio
    let chainVoiceId: string | null = null;
    let chainRequestIds: string[] = [];

    // Prosody conditioning must come from neighboring SPEECH, never from a
    // sound-effect prompt, and always from the raw (untagged) text.
    const neighborText = (from: number, dir: -1 | 1): string | undefined => {
      for (let j = from + dir; j >= 0 && j < segs.length; j += dir) {
        if (segs[j].kind !== "sfx") return segs[j].text;
      }
      return undefined;
    };

    for (let i = 0; i < segs.length; i++) {
      assertNotCancelled(jobId); // stop spending credits promptly on cancel
      const seg = segs[i];

      if (seg.kind === "sfx") {
        const seconds = seg.sfxDurationSec ?? DEFAULT_SFX_SECONDS;
        const cacheKey = createHash("sha256")
          .update(JSON.stringify([seg.text, seconds, "sfx-v2"]))
          .digest("hex");
        const relPath = segmentAudioPath(chapter.bookId, cacheKey);
        let fresh = false;
        let sfxAudio: Buffer;
        if (audioExists(relPath)) {
          sfxAudio = readAudio(relPath);
        } else {
          sfxAudio = await soundEffect({ text: seg.text, durationSec: seconds });
          writeAudio(relPath, sfxAudio);
          fresh = true;
        }
        chainVoiceId = null;
        chainRequestIds = [];
        db.update(segments).set({ audioPath: relPath }).where(eq(segments.id, seg.id)).run();
        chapterBuffers.push(sfxAudio);
        tickJob(jobId, {
          chars: fresh ? estimateSfxCredits(seconds) : 0,
          note: `Sound effect — ${seg.text}${fresh ? "" : " (cached)"}`,
        });
        continue;
      }

      const assignment = resolve(seg.characterId)!;
      const plan = renderPlan(seg, assignment.settings, book.renderModel);
      const cacheKey = createHash("sha256")
        .update(
          JSON.stringify([
            plan.renderedText,
            assignment.voiceId,
            plan.settings,
            book.renderModel,
            assignment.seed,
          ])
        )
        .digest("hex");
      const relPath = segmentAudioPath(chapter.bookId, cacheKey);

      let segAudio: Buffer;
      let freshChars = 0;
      if (audioExists(relPath)) {
        segAudio = readAudio(relPath);
        // Cached audio has no request id — the chain breaks here
        chainVoiceId = null;
        chainRequestIds = [];
      } else {
        const pieces = splitForModel(plan.renderedText, book.renderModel);
        const pieceBuffers: Buffer[] = [];
        if (chainVoiceId !== assignment.voiceId) {
          chainVoiceId = assignment.voiceId;
          chainRequestIds = [];
        }
        for (let p = 0; p < pieces.length; p++) {
          const previousText =
            p > 0 ? pieces[p - 1].slice(-CONTEXT_CHARS) : neighborText(i, -1)?.slice(-CONTEXT_CHARS);
          const nextText =
            p < pieces.length - 1
              ? pieces[p + 1].slice(0, CONTEXT_CHARS)
              : neighborText(i, 1)?.slice(0, CONTEXT_CHARS);
          const result = await ttsConvert({
            voiceId: assignment.voiceId,
            text: pieces[p],
            modelId: book.renderModel,
            settings: plan.settings,
            seed: assignment.seed,
            previousText,
            nextText,
            previousRequestIds: chainRequestIds,
          });
          pieceBuffers.push(result.audio);
          // v3 has no request stitching — don't accumulate a dead chain
          if (!isV3(book.renderModel) && result.requestId) {
            chainRequestIds = [...chainRequestIds, result.requestId].slice(-3);
          }
          freshChars += pieces[p].length;
        }
        segAudio =
          pieceBuffers.length === 1 ? pieceBuffers[0] : concatMp3(pieceBuffers).data;
        writeAudio(relPath, segAudio);
      }

      db.update(segments).set({ audioPath: relPath }).where(eq(segments.id, seg.id)).run();
      chapterBuffers.push(segAudio);
      const speaker = seg.characterId ? (nameById.get(seg.characterId) ?? "?") : "Narrator";
      tickJob(jobId, {
        chars: freshChars,
        note: `Segment ${i + 1}/${segs.length} — ${speaker}${freshChars === 0 ? " (cached)" : ""}`,
      });
    }

    const { data, durationSec } = concatMp3(chapterBuffers);
    const chapterRel = chapterAudioPath(chapter.bookId, chapter.idx);
    writeAudio(chapterRel, data);

    db.update(chapters)
      .set({ status: "ready", audioPath: chapterRel, durationSec, error: null })
      .where(eq(chapters.id, chapterId))
      .run();
    completeJob(jobId);
    refreshBookStatus(chapter.bookId);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      // Rendered segments stay cached; the chapter just isn't assembled.
      db.update(chapters)
        .set({ status: "scripted", error: null })
        .where(eq(chapters.id, chapterId))
        .run();
      refreshBookStatus(chapterIdToBookId(chapterId));
      return;
    }
    console.error(`Chapter generation failed (${chapterId}):`, err);
    failJob(jobId, err);
    db.update(chapters)
      .set({ status: "error", error: err instanceof Error ? err.message : String(err) })
      .where(eq(chapters.id, chapterId))
      .run();
    refreshBookStatus(chapterIdToBookId(chapterId));
  }
}

/** Script (if needed) then generate every non-ready chapter, a couple at a time. */
export async function generateBook(bookId: string): Promise<void> {
  const pending = db
    .select({ id: chapters.id, status: chapters.status })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.idx))
    .all()
    .filter((c) => c.status !== "ready");

  db.update(books).set({ status: "generating" }).where(eq(books.id, bookId)).run();

  const CHAPTER_WORKERS = 2;
  let next = 0;
  let cancelled = false;
  async function worker() {
    while (!cancelled && next < pending.length) {
      const ch = pending[next++];
      const jobId = createJob("generate", bookId, ch.id);
      try {
        const hasScript =
          db.select({ id: segments.id }).from(segments).where(eq(segments.chapterId, ch.id)).limit(1).all()
            .length > 0;
        if (!hasScript || ch.status === "pending") {
          noteJob(jobId, "Scripting chapter…");
          db.update(chapters).set({ status: "scripting" }).where(eq(chapters.id, ch.id)).run();
          await withHeartbeat(jobId, () => scriptChapter(ch.id));
          assertNotCancelled(jobId);
        }
        await withHeartbeat(jobId, () => generateChapter(ch.id, jobId));
      } catch (err) {
        if (err instanceof JobCancelledError) {
          // Thrown after scripting finished, so the script is in place
          db.update(chapters)
            .set({ status: "scripted", error: null })
            .where(eq(chapters.id, ch.id))
            .run();
          cancelled = true;
          return;
        }
        failJob(jobId, err);
        db.update(chapters)
          .set({ status: "error", error: err instanceof Error ? err.message : String(err) })
          .where(eq(chapters.id, ch.id))
          .run();
      }
      // A cancelled chapter job means the whole book run was cancelled
      if (jobStatus(jobId) === "cancelled") cancelled = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHAPTER_WORKERS, pending.length) }, worker));
  refreshBookStatus(bookId);
}

function chapterIdToBookId(chapterId: string): string {
  return (
    db.select({ bookId: chapters.bookId }).from(chapters).where(eq(chapters.id, chapterId)).get()
      ?.bookId ?? ""
  );
}

export function refreshBookStatus(bookId: string): void {
  if (!bookId) return;
  const statuses = db
    .select({ status: chapters.status })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .all()
    .map((c) => c.status);
  if (statuses.length === 0) return;

  let status: "ready" | "generating" | "cast" | null = null;
  if (statuses.every((s) => s === "ready")) status = "ready";
  else if (statuses.some((s) => s === "generating" || s === "scripting")) status = "generating";
  else {
    const book = db.select({ status: books.status }).from(books).where(eq(books.id, bookId)).get();
    if (book?.status === "generating") status = "cast"; // finished but not everything is ready
  }
  if (status) {
    db.update(books).set({ status }).where(eq(books.id, bookId)).run();
  }
}

/** Mark ready chapters containing this character's segments as stale (voice changed). */
export function markStaleForCharacter(characterId: string, bookId: string, isNarrator: boolean): number {
  const chapterRows = db
    .select({ id: chapters.id, status: chapters.status })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .all()
    .filter((c) => c.status === "ready" || c.status === "stale");
  if (chapterRows.length === 0) return 0;

  const affected = new Set(
    db
      .select({ chapterId: segments.chapterId, characterId: segments.characterId })
      .from(segments)
      .where(inArray(segments.chapterId, chapterRows.map((c) => c.id)))
      .all()
      .filter((s) => (isNarrator ? s.characterId === null : s.characterId === characterId))
      .map((s) => s.chapterId)
  );

  const toMark = chapterRows.filter((c) => c.status === "ready" && affected.has(c.id));
  for (const c of toMark) {
    db.update(chapters).set({ status: "stale" }).where(eq(chapters.id, c.id)).run();
  }
  return toMark.length;
}
