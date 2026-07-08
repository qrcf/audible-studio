ALTER TABLE "jobs" ADD COLUMN "script_first" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_type_status_created_idx" ON "jobs" USING btree ("type","status","created_at");