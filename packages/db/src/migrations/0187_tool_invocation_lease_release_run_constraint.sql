ALTER TABLE "tool_invocations"
  ADD CONSTRAINT "tool_invocations_lease_release_requires_run_chk"
  CHECK ("lease_release_pending_at" IS NULL OR "run_id" IS NOT NULL)
  NOT VALID;--> statement-breakpoint
ALTER TABLE "tool_invocations"
  VALIDATE CONSTRAINT "tool_invocations_lease_release_requires_run_chk";
