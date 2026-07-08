<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Database schema changes

NEVER use `drizzle-kit push`. Schema changes go through committed migrations only: edit `lib/db/schema.ts` → `pnpm db:generate` → review the SQL in `./drizzle` → `pnpm db:migrate` (locally against the local `audible` Postgres DB; in prod with pulled Neon env vars, before promoting the deploy).
