import { eq } from "drizzle-orm";
import { getRun } from "workflow/api";
import { getDb, jobs } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { cancelJob } from "@/lib/jobs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [job] = await getDb().select({ runId: jobs.runId }).from(jobs).where(eq(jobs.id, id)).limit(1);
    // Primary mechanism: flip the flag; steps observe it at the next safe point
    // and the workflow runs its own unwind steps.
    const cancelled = await cancelJob(id);
    // Backstop only — kills a run stuck in retry backoff; the reconciler then
    // handles status rollback if the run dies before unwinding.
    if (cancelled && job?.runId) {
      await getRun(job.runId).cancel().catch(() => {});
    }
    return Response.json({ cancelled });
  } catch (err) {
    return errorResponse(err);
  }
}
