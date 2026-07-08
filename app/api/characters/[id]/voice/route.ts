import { randomUUID, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, characters, voiceAssignments } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";
import { getVoiceCatalog } from "@/lib/elevenlabs/catalog";
import { DEFAULT_SETTINGS, NARRATOR_SETTINGS } from "@/lib/elevenlabs/tts";
import { markStaleForCharacter } from "@/lib/generation";

const bodySchema = z.object({
  voiceId: z.string().optional(),
  settings: z
    .object({
      stability: z.number().min(0).max(1),
      similarityBoost: z.number().min(0).max(1),
      style: z.number().min(0).max(1),
      speed: z.number().min(0.7).max(1.2),
    })
    .optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = bodySchema.parse(await req.json());
    if (!body.voiceId && !body.settings) {
      throw new AppError("Nothing to update", "bad_request");
    }

    const db = getDb();
    const [character] = await db.select().from(characters).where(eq(characters.id, id)).limit(1);
    if (!character) throw new AppError("Character not found", "not_found", 404);

    const [existing] = await db
      .select()
      .from(voiceAssignments)
      .where(eq(voiceAssignments.characterId, id))
      .limit(1);

    const voiceId = body.voiceId ?? existing?.voiceId;
    if (!voiceId) throw new AppError("No voice selected", "bad_request");

    let voiceName = existing?.voiceName ?? voiceId;
    if (body.voiceId) {
      const voice = (await getVoiceCatalog()).find((v) => v.id === body.voiceId);
      if (!voice) throw new AppError("Voice not found in your ElevenLabs account", "voice_not_found", 404);
      voiceName = voice.name;
    }

    const settings =
      body.settings ??
      existing?.settings ??
      (character.isNarrator ? NARRATOR_SETTINGS : DEFAULT_SETTINGS);

    if (existing) {
      await db.update(voiceAssignments)
        .set({ voiceId, voiceName, settings, overridden: true, rationale: existing.rationale })
        .where(eq(voiceAssignments.characterId, id));
    } else {
      await db.insert(voiceAssignments)
        .values({
          id: randomUUID(),
          characterId: id,
          voiceId,
          voiceName,
          settings,
          seed: randomInt(0, 2 ** 31),
          rationale: "Manually selected",
          overridden: true,
        });
    }

    const staleChapters = await markStaleForCharacter(id, character.bookId, character.isNarrator);
    return Response.json({ ok: true, voiceId, voiceName, staleChapters });
  } catch (err) {
    return errorResponse(err);
  }
}
