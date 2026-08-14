ALTER TABLE "tool_invocations"
  ADD COLUMN IF NOT EXISTS "lease_release_pending_at" timestamptz;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tool_invocations_lease_release_pending_idx"
  ON "tool_invocations" USING btree ("lease_release_pending_at", "id")
  WHERE "lease_release_pending_at" IS NOT NULL;
