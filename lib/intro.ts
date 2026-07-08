import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, books } from "@/lib/db";
import type { NarratorProfile } from "@/lib/db/schema";
import { getAssignmentResolver, type Assignment } from "@/lib/generation";
import { generateMusic, INTRO_MUSIC_PROMPT } from "@/lib/elevenlabs/music";
import { ttsConvert } from "@/lib/elevenlabs/tts";
import { concatMp3, segmentAudioDurationSec } from "@/lib/audio/mp3";
import { mixIntro } from "@/lib/audio/mix";
import { deleteBlobs, readBlobIfExists, writeAudio } from "@/lib/storage";

const INTRO_MUSIC_MS = 8000;

/**
 * Instrumental brief for the intro bed, themed to the book's mood via the
 * narrator profile (its tone/description are the analysis's read on the book's
 * feel). Deterministic — no LLM call — so it's safe inside the render workflow
 * and gives a stable cache key.
 */
function musicPromptFor(title: string, narrator: NarratorProfile | null): string {
  if (!narrator) return INTRO_MUSIC_PROMPT;
  const mood = [narrator.tone, narrator.description].filter(Boolean).join("; ");
  return (
    `Short instrumental intro cue for the audiobook "${title}". ` +
    `Match this mood: ${mood}. ` +
    `Fit the genre and atmosphere it implies; a brief, cinematic flourish that resolves cleanly. ` +
    `No vocals, no speech.`
  );
}

export interface IntroResult {
  audioPath: string;
  durationSec: number;
}

/**
 * Build (or reuse) the book's standalone intro section: the narrator speaking
 * "{Title}, by {Author}" mixed over a themed music bed. Stored on the book as
 * its own audio blob — never concatenated into a chapter — so it plays as its
 * own section and can be regenerated independently.
 *
 * Music and speech are decoded, mixed as PCM (voice over a ducked bed), and
 * re-encoded into one homogeneous stereo stream — byte-concat is off the table
 * because the clips differ in channel mode, which players punish with
 * pitch-shifted static. If the mix fails, the music is dropped rather than
 * shipping a broken section.
 *
 * Returns null (and leaves the book unchanged) when the narrator isn't cast.
 */
export async function ensureBookIntro(bookId: string, force = false): Promise<IntroResult | null> {
  const db = getDb();
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) return null;

  const { resolve } = await getAssignmentResolver(bookId);
  const narrator = resolve(null);
  if (!narrator) return null; // narrator uncast — no intro yet

  const introText = book.author ? `${book.title}, by ${book.author}.` : `${book.title}.`;
  // A user-written brief wins over the auto-derived one. It's part of the cache
  // key below, so editing it regenerates the section on the next ensure/force.
  const musicPrompt =
    book.introMusicPrompt?.trim() || musicPromptFor(book.title, book.narratorProfile);
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        introText,
        musicPrompt,
        narrator.voiceId,
        narrator.settings,
        book.renderModel,
        "intro-v3",
      ])
    )
    .digest("hex")
    .slice(0, 16);
  const introPath = `intro/${bookId}/${key}.mp3`;

  // Already current — nothing to do (cache the composed section by content key).
  if (!force && book.introAudioPath === introPath) {
    return { audioPath: introPath, durationSec: book.introDurationSec ?? 0 };
  }
  const cached = !force ? await readBlobIfExists(introPath) : null;

  const intro = cached ?? (await compose(introText, musicPrompt, narrator, book.renderModel));
  if (!cached) await writeAudio(introPath, intro);
  const durationSec = segmentAudioDurationSec(intro);

  const previous = book.introAudioPath;
  await db.update(books).set({ introAudioPath: introPath, introDurationSec: durationSec }).where(eq(books.id, bookId));
  if (previous && previous !== introPath) await deleteBlobs(previous).catch(() => {});

  return { audioPath: introPath, durationSec };
}

async function compose(
  introText: string,
  musicPrompt: string,
  narrator: Assignment,
  modelId: string
): Promise<Buffer> {
  const voicePromise = ttsConvert({
    voiceId: narrator.voiceId,
    text: introText,
    modelId, // speech is always mp3_44100_128 regardless of model
    settings: narrator.settings,
    seed: narrator.seed,
  });

  try {
    const [music, voice] = await Promise.all([
      generateMusic(musicPrompt, INTRO_MUSIC_MS),
      voicePromise,
    ]);
    return await mixIntro(music, voice.audio);
  } catch (err) {
    // A voice-only intro beats a failed job (or a broken-sounding one).
    console.warn("Intro music/mix failed; dropping music bed to keep the title clear:", err);
    const voice = await voicePromise;
    return concatMp3([voice.audio]).data;
  }
}
