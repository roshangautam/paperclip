ALTER TABLE "tool_invocations"
  ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "tool_invocations"
    ADD CONSTRAINT "tool_invocations_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tool_invocations_project_idx"
  ON "tool_invocations" USING btree ("company_id", "project_id");
