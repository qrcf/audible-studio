// Applies committed Drizzle migrations (./drizzle) against Postgres.
// Runs in the Vercel build (env comes from the platform) and locally
// (falls back to reading .env.local). NEVER uses drizzle-kit push.
import { existsSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Local dev: hydrate process.env from .env.local (Vercel already injects env).
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

// Migrations want a direct connection; Neon exposes it as DATABASE_URL_UNPOOLED.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  // No DB wired for this environment (e.g. a preview without one) — don't
  // fail the build; the app just won't have a database until env is set.
  console.warn("migrate: DATABASE_URL not set — skipping migrations");
  process.exit(0);
}

const pool = new Pool({ connectionString: url });
try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("migrate: schema up to date");
} finally {
  await pool.end();
}
