WITH "eligible_reusable_identities" AS (
  SELECT DISTINCT
    "company_id",
    "environment_id",
    "provider",
    "provider_lease_id"
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
  "reusable_resource_owner" = false,
  "reusable_adoption_claim_id" = NULL
FROM "eligible_reusable_identities" AS "identity"
WHERE "lease"."company_id" = "identity"."company_id"
  AND "lease"."environment_id" = "identity"."environment_id"
  AND "lease"."provider" = "identity"."provider"
  AND "lease"."provider_lease_id" = "identity"."provider_lease_id";--> statement-breakpoint

WITH "ranked_reusable_resources" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "company_id", "environment_id", "provider", "provider_lease_id"
      ORDER BY
        "created_at" DESC,
        CASE "status"
          WHEN 'active' THEN 0
          WHEN 'pending_cleanup' THEN 1
          WHEN 'retained' THEN 2
          WHEN 'released' THEN 3
          ELSE 4
        END,
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
  AND "ranked"."resource_rank" = 1;
