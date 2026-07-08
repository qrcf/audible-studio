import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

function createDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // Small per-instance pool: serverless instances are many, Postgres
  // connections are few (Neon's pooled endpoint multiplexes the rest).
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000 });
  return drizzle(pool, { schema });
}

// Reuse one pool across Next.js dev hot reloads and warm serverless instances.
const globalForDb = globalThis as unknown as { __audibleDb?: Db };

// Lazy: module-scope init would crash `next build` when DATABASE_URL is unset.
export function getDb(): Db {
  return (globalForDb.__audibleDb ??= createDb());
}

export * from "./schema";
