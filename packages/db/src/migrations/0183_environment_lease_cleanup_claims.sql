ALTER TABLE "environment_leases"
  ADD COLUMN IF NOT EXISTS "cleanup_claim_id" uuid,
  ADD COLUMN IF NOT EXISTS "cleanup_claimed_at" timestamp with time zone;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "environment_leases_pending_cleanup_idx"
  ON "environment_leases" USING btree ("updated_at", "cleanup_claimed_at")
  WHERE "status" = 'pending_cleanup' AND "lease_policy" = 'ephemeral';
