import { composeIntro, failIntro, finishIntro } from "./steps";

/** (Re)generate the book's standalone intro section as a tracked, resumable job. */
export async function introWorkflow(bookId: string, jobId: string): Promise<void> {
  "use workflow";
  try {
    const { cancelled } = await composeIntro(bookId, jobId);
    if (cancelled) return; // job already flipped to cancelled by the cancel route
    await finishIntro(jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failIntro(jobId, message);
    throw err; // run shows failed in observability
  }
}
