import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, characters } from "@/lib/db";
import { errorResponse, AppError } from "@/lib/errors";

interface VariantInput {
  label: string;
  ageRange: string;
}

/**
 * Split a character into age variants. The original row keeps its id — and
 * therefore its voice assignment and every attributed segment — becoming the
 * first variant; the remaining labels are inserted as uncast siblings.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const character = db.select().from(characters).where(eq(characters.id, id)).get();
    if (!character) throw new AppError("Character not found", "not_found", 404);
    if (character.isNarrator) throw new AppError("The narrator can't be split", "not_splittable");
    if (character.variantGroup) {
      throw new AppError("Already an age variant — remove variants instead", "already_variant");
    }

    const body = (await req.json()) as { variants?: VariantInput[] };
    const variants = (body.variants ?? []).map((v) => ({
      label: String(v.label ?? "").trim().toLowerCase(),
      ageRange: String(v.ageRange ?? "").trim(),
    }));
    if (variants.length < 2) throw new AppError("At least two age variants required", "bad_variants");
    if (variants.some((v) => !v.label)) throw new AppError("Every variant needs a label", "bad_variants");
    if (new Set(variants.map((v) => v.label)).size !== variants.length) {
      throw new AppError("Variant labels must be unique", "bad_variants");
    }

    const base = character.name;
    const withBaseAlias = (ownName: string) => {
      const seen = new Set([ownName.toLowerCase()]);
      const out: string[] = [];
      for (const alias of [base, ...character.aliases]) {
        const key = alias.trim().toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          out.push(alias.trim());
        }
      }
      return out;
    };

    const created: { id: string; name: string }[] = [];
    db.transaction((tx) => {
      const [first, ...rest] = variants;
      const firstName = `${base} (${first.label})`;
      tx.update(characters)
        .set({
          name: firstName,
          variantGroup: base,
          variantLabel: first.label,
          aliases: withBaseAlias(firstName),
          profile: { ...character.profile, ageRange: first.ageRange || character.profile.ageRange },
        })
        .where(eq(characters.id, id))
        .run();
      created.push({ id, name: firstName });

      for (const v of rest) {
        const newId = randomUUID();
        const name = `${base} (${v.label})`;
        tx.insert(characters)
          .values({
            id: newId,
            bookId: character.bookId,
            name,
            aliases: withBaseAlias(name),
            role: character.role,
            profile: { ...character.profile, ageRange: v.ageRange || character.profile.ageRange },
            quotes: [],
            dialogueShare: 0,
            isNarrator: false,
            variantGroup: base,
            variantLabel: v.label,
          })
          .run();
        created.push({ id: newId, name });
      }
    });

    return Response.json({ ok: true, characters: created });
  } catch (err) {
    return errorResponse(err);
  }
}
