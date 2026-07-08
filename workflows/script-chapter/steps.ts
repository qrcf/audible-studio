import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { getDb, chapters } from "@/lib/db";
import {
  attributeChunkLlm,
  detectPovLlm,
  performanceChunkLlm,
  performancePlan,
  writeScript,
  type Attribution,
  type DeliveryNote,
  type SfxNote,
} from "@/lib/analysis/scripting";
import { failJob, isCancelled, noteJob, setJobProgress, setJobTotal } from "@/lib/jobs";
import { sampleHasScript } from "@/lib/pipeline";

export type { Attribution, DeliveryNote, SfxNote };

export interface PovResult {
  cancelled: boolean;
  povCharacterId: string | null;
  attrChunkCount: number;
}

/** POV detection + attribution chunk plan (jobId optional: book runs skip progress). */
export async function detectPovStep(chapterId: string, jobId: string | null): Promise<PovResult> {
  "use step";
  if (jobId) {
    if (await isCancelled(jobId)) {
      return { cancelled: true, povCharacterId: null, attrChunkCount: 0 };
    }
    await noteJob(jobId, "Detecting the chapter's narrating voice");
  }
  const { povCharacterId, attrChunkCount } = await detectPovLlm(chapterId);
  return { cancelled: false, povCharacterId, attrChunkCount };
}

export async function setScriptTotal(jobId: string, total: number): Promise<void> {
  "use step";
  await setJobTotal(jobId, total);
}

export interface AttributeChunkResult {
  cancelled: boolean;
  attributions: Attribution[];
  recent: string[];
}

export async function attributeChunk(
  chapterId: string,
  jobId: string | null,
  ci: number,
  chunkCount: number,
  recent: string[],
  povCharacterId: string | null
): Promise<AttributeChunkResult> {
  "use step";
  if (jobId && (await isCancelled(jobId))) {
    return { cancelled: true, attributions: [], recent };
  }
  const out = await attributeChunkLlm(chapterId, ci, recent, povCharacterId);
  if (jobId) {
    await setJobProgress(jobId, {
      done: ci + 1,
      note: `Identifying speakers ${ci + 1}/${chunkCount} (${out.quoteCount} quotes)`,
    });
  }
  return { cancelled: false, attributions: out.attributions, recent: out.recent };
}

export async function planPerformance(
  chapterId: string,
  jobId: string | null,
  attrChunkCount: number,
  attributions: Attribution[],
  povCharacterId: string | null
): Promise<{ chunkCount: number }> {
  "use step";
  const plan = await performancePlan(chapterId, attributions, povCharacterId);
  if (jobId && plan.chunkCount > 0) {
    await setJobTotal(jobId, attrChunkCount + plan.chunkCount);
  }
  return plan;
}

export interface PerformanceChunkResult {
  cancelled: boolean;
  deliveries: DeliveryNote[];
  sfx: SfxNote[];
}

export async function performanceChunk(
  chapterId: string,
  jobId: string | null,
  attrChunkCount: number,
  ci: number,
  chunkCount: number,
  attributions: Attribution[],
  povCharacterId: string | null
): Promise<PerformanceChunkResult> {
  "use step";
  if (jobId && (await isCancelled(jobId))) {
    return { cancelled: true, deliveries: [], sfx: [] };
  }
  const out = await performanceChunkLlm(chapterId, attributions, povCharacterId, ci);
  if (jobId) {
    await setJobProgress(jobId, {
      done: attrChunkCount + ci + 1,
      note: `Performance notes ${ci + 1}/${chunkCount}`,
    });
  }
  return { cancelled: false, ...out };
}

export async function writeScriptStep(
  chapterId: string,
  attributions: Attribution[],
  deliveries: DeliveryNote[],
  sfx: SfxNote[],
  povCharacterId: string | null
): Promise<{ segmentCount: number; flagged: number }> {
  "use step";
  return writeScript(chapterId, attributions, deliveries, sfx, povCharacterId);
}

export async function markChapterScripting(chapterId: string): Promise<void> {
  "use step";
  await getDb()
    .update(chapters)
    .set({ status: "scripting", error: null })
    .where(eq(chapters.id, chapterId));
}

/** Cancelled scripting rolls back to the last stable status. */
export async function unwindScriptCancelled(chapterId: string): Promise<void> {
  "use step";
  await getDb()
    .update(chapters)
    .set({ status: (await sampleHasScript(chapterId)) ? "scripted" : "pending", error: null })
    .where(eq(chapters.id, chapterId));
}

export async function failScript(
  chapterId: string,
  jobId: string | null,
  message: string
): Promise<void> {
  "use step";
  console.error(`Scripting failed (${chapterId}):`, message);
  if (jobId) await failJob(jobId, message);
  await getDb()
    .update(chapters)
    .set({ status: "error", error: message })
    .where(eq(chapters.id, chapterId));
}

/** Guard used by book runs between the scripting and rendering phases. */
export async function checkJobCancelled(jobId: string): Promise<boolean> {
  "use step";
  return isCancelled(jobId);
}

export async function assertChapterExists(chapterId: string): Promise<string> {
  "use step";
  const [chapter] = await getDb()
    .select({ bookId: chapters.bookId })
    .from(chapters)
    .where(eq(chapters.id, chapterId))
    .limit(1);
  if (!chapter) throw new FatalError("Chapter not found");
  return chapter.bookId;
}
