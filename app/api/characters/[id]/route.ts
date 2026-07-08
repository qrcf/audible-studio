import { and, eq, ne } from "drizzle-orm";
import { db, characters, segments } from "@/lib/db";
import type { CharacterProfile } from "@/lib/db/schema";
import { errorResponse, AppError } from "@/lib/errors";
import { markStaleForCharacter } from "@/lib/generation";

type Ctx = { params: Promise<{ id: string }> };

const PROFILE_KEYS = [
  "gender",
  "ageRange",
  "personality",
  "speechStyle",
  "accentHint",
  "heritage",
  "voiceTexture",
] as const;
const GENDERS = ["male", "female", "nonbinary", "unknown"];

/** Edit a character's casting profile; edits survive re-analysis by exact name. */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const character = db.select().from(characters).where(eq(characters.id, id)).get();
    if (!character) throw new AppError("Character not found", "not_found", 404);

    const body = (await req.json()) as { profile?: Record<string, unknown> };
    if (typeof body.profile !== "object" || body.profile === null) {
      throw new AppError("profile object required", "bad_profile");
    }
    const patch: Partial<CharacterProfile> = {};
    for (const [key, value] of Object.entries(body.profile)) {
      if (!PROFILE_KEYS.includes(key as (typeof PROFILE_KEYS)[number])) {
        throw new AppError(`Unknown profile field "${key}"`, "bad_profile");
      }
      if (typeof value !== "string") {
        throw new AppError(`${key} must be a string`, "bad_profile");
      }
      if (key === "gender" && !GENDERS.includes(value)) {
        throw new AppError(`gender must be one of ${GENDERS.join(", ")}`, "bad_profile");
      }
      patch[key as keyof CharacterProfile] = value as never;
    }
    if (Object.keys(patch).length === 0) {
      throw new AppError("No profile fields to update", "bad_profile");
    }

    const profile = { ...character.profile, ...patch };
    db.update(characters)
      .set({ profile, profileEdited: true })
      .where(eq(characters.id, id))
      .run();
    return Response.json({ ok: true, profile });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Remove an age variant. Its lines are reassigned to a sibling variant (never
 * silently dropped to the narrator), affected chapters go stale, and a lone
 * remaining sibling collapses back into a standalone character.
 */
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const character = db.select().from(characters).where(eq(characters.id, id)).get();
    if (!character) throw new AppError("Character not found", "not_found", 404);
    if (character.isNarrator || !character.variantGroup || !character.variantLabel) {
      throw new AppError("Only age variants can be removed", "not_a_variant");
    }

    const body = (await req.json().catch(() => ({}))) as { reassignTo?: string };
    const siblings = db
      .select()
      .from(characters)
      .where(
        and(
          eq(characters.bookId, character.bookId),
          eq(characters.variantGroup, character.variantGroup),
          ne(characters.id, id)
        )
      )
      .all()
      .sort((a, b) => b.dialogueShare - a.dialogueShare);
    if (siblings.length === 0) {
      throw new AppError("No sibling variant to reassign lines to", "no_sibling");
    }
    const target = body.reassignTo
      ? siblings.find((s) => s.id === body.reassignTo)
      : siblings[0];
    if (!target) {
      throw new AppError("reassignTo must be a sibling variant", "bad_target");
    }

    // Before the segments move: mark chapters that contain this voice stale
    const staleChapters = markStaleForCharacter(id, character.bookId, false);

    let collapsed = false;
    db.transaction((tx) => {
      tx.update(segments)
        .set({ characterId: target.id, audioPath: null })
        .where(eq(segments.characterId, id))
        .run();
      tx.delete(characters).where(eq(characters.id, id)).run();
      if (siblings.length === 1) {
        // Last sibling standing becomes the plain character again
        const base = character.variantGroup!;
        tx.update(characters)
          .set({
            name: base,
            variantGroup: null,
            variantLabel: null,
            aliases: target.aliases.filter((a) => a.trim().toLowerCase() !== base.toLowerCase()),
          })
          .where(eq(characters.id, target.id))
          .run();
        collapsed = true;
      }
    });

    return Response.json({ ok: true, reassignedTo: target.name, staleChapters, collapsed });
  } catch (err) {
    return errorResponse(err);
  }
}
