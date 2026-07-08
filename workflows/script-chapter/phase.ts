import {
  attributeChunk,
  detectPovStep,
  failScript,
  performanceChunk,
  planPerformance,
  setScriptTotal,
  unwindScriptCancelled,
  writeScriptStep,
  type Attribution,
  type DeliveryNote,
  type SfxNote,
} from "./steps";

export interface ScriptPhaseResult {
  outcome: "scripted" | "cancelled" | "failed";
  error?: string;
}

// Duplicated from lib/analysis/scripting (MAX_SFX_PER_CHAPTER) — workflow
// orchestration code runs in the sandbox and can't import Node-flavoured libs.
const SFX_CAP = 2;

/**
 * Orchestrates one chapter's scripting: POV detection, sequential attribution
 * chunks (rolling context between them), performance pass, then the write
 * transaction. Runs inside a workflow body; every await is a step. Marks its
 * own failure/cancel state so callers just branch on the outcome. Passing a
 * null jobId skips progress + cancellation bookkeeping (book runs track the
 * chapter through their own generate job instead).
 */
export async function runScriptPhase(
  chapterId: string,
  jobId: string | null
): Promise<ScriptPhaseResult> {
  try {
    const pov = await detectPovStep(chapterId, jobId);
    if (pov.cancelled) {
      await unwindScriptCancelled(chapterId);
      return { outcome: "cancelled" };
    }
    if (jobId && pov.attrChunkCount > 0) {
      await setScriptTotal(jobId, pov.attrChunkCount);
    }

    const attributions: Attribution[] = [];
    let recent: string[] = [];
    for (let ci = 0; ci < pov.attrChunkCount; ci++) {
      const out = await attributeChunk(
        chapterId,
        jobId,
        ci,
        pov.attrChunkCount,
        recent,
        pov.povCharacterId
      );
      if (out.cancelled) {
        await unwindScriptCancelled(chapterId);
        return { outcome: "cancelled" };
      }
      attributions.push(...out.attributions);
      recent = out.recent;
    }

    const plan = await planPerformance(
      chapterId,
      jobId,
      pov.attrChunkCount,
      attributions,
      pov.povCharacterId
    );
    const deliveries: DeliveryNote[] = [];
    const sfx: SfxNote[] = [];
    for (let ci = 0; ci < plan.chunkCount; ci++) {
      const out = await performanceChunk(
        chapterId,
        jobId,
        pov.attrChunkCount,
        ci,
        plan.chunkCount,
        attributions,
        pov.povCharacterId
      );
      if (out.cancelled) {
        await unwindScriptCancelled(chapterId);
        return { outcome: "cancelled" };
      }
      deliveries.push(...out.deliveries);
      for (const s of out.sfx) {
        if (sfx.length < SFX_CAP) sfx.push(s);
      }
    }

    await writeScriptStep(chapterId, attributions, deliveries, sfx, pov.povCharacterId);
    return { outcome: "scripted" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failScript(chapterId, jobId, message);
    return { outcome: "failed", error: message };
  }
}
