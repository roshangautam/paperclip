ALTER TABLE "environment_leases"
  ADD COLUMN IF NOT EXISTS "reusable_resource_owner" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "reusable_adoption_claim_id" uuid;--> statement-breakpoint

WITH "ranked_reusable_resources" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "company_id", "environment_id", "provider", "provider_lease_id"
      ORDER BY
        CASE "status"
          WHEN 'active' THEN 0
          WHEN 'pending_cleanup' THEN 1
          WHEN 'retained' THEN 2
          WHEN 'released' THEN 3
          ELSE 4
        END,
        "created_at" DESC,
        "id" DESC
    ) AS "resource_rank"
  FROM "environment_leases"
  WHERE "lease_policy" = 'reuse_by_environment'
    AND "provider" IS NOT NULL
    AND "provider_lease_id" IS NOT NULL
    AND (
      "status" IN ('active', 'pending_cleanup', 'retained', 'released')
      OR ("status" = 'failed' AND "cleanup_status" IS DISTINCT FROM 'success')
    )
)
UPDATE "environment_leases" AS "lease"
SET
  "reusable_resource_owner" = true,
  "reusable_adoption_claim_id" = NULL
FROM "ranked_reusable_resources" AS "ranked"
WHERE "ranked"."id" = "lease"."id"
  AND "ranked"."resource_rank" = 1;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "environment_leases_reusable_resource_owner_idx"
  ON "environment_leases" USING btree ("company_id", "environment_id", "provider", "provider_lease_id")
  WHERE "reusable_resource_owner" = true;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "environment_leases"
    ADD CONSTRAINT "environment_leases_reusable_resource_owner_identity_check"
    CHECK (
      NOT "reusable_resource_owner"
      OR (
        "lease_policy" = 'reuse_by_environment'
        AND "provider" IS NOT NULL
        AND "provider_lease_id" IS NOT NULL
      )
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "environment_leases"
    ADD CONSTRAINT "environment_leases_reusable_adoption_claim_owner_check"
    CHECK ("reusable_adoption_claim_id" IS NULL OR "reusable_resource_owner");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "environment_leases"
    ADD CONSTRAINT "environment_leases_reusable_claim_exclusion_check"
    CHECK ("reusable_adoption_claim_id" IS NULL OR "cleanup_claim_id" IS NULL);
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
