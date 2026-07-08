import { eq } from "drizzle-orm";
import { getDb, jobs } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(job);
}
