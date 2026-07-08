import { eq } from "drizzle-orm";
import { db, jobs } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(job);
}
