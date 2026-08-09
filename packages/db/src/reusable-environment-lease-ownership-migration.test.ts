import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0185_repair_reusable_environment_lease_ownership.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("reusable environment lease ownership repair", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("prefers creation time and uses status only to break ties", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-reusable-owner-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    const companyId = randomUUID();
    const environmentId = randomUUID();
    const olderActiveId = "00000000-0000-4000-8000-000000000001";
    const newerReleasedId = "00000000-0000-4000-8000-000000000002";
    const tiedReleasedId = "00000000-0000-4000-8000-000000000003";
    const tiedActiveId = "00000000-0000-4000-8000-000000000004";

    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Lease repair', 'LRP')`;
    await sql`INSERT INTO "environments" ("id", "name", "driver") VALUES (${environmentId}, ${`Lease repair ${environmentId}`}, 'sandbox')`;
    await sql`
      INSERT INTO "environment_leases" (
        "id", "company_id", "environment_id", "status", "lease_policy", "provider",
        "provider_lease_id", "created_at", "reusable_resource_owner"
      ) VALUES
        (${olderActiveId}, ${companyId}, ${environmentId}, 'active', 'reuse_by_environment', 'coder', 'chronology', '2026-08-01T00:00:00Z', true),
        (${newerReleasedId}, ${companyId}, ${environmentId}, 'released', 'reuse_by_environment', 'coder', 'chronology', '2026-08-02T00:00:00Z', false),
        (${tiedReleasedId}, ${companyId}, ${environmentId}, 'released', 'reuse_by_environment', 'coder', 'status-tie', '2026-08-03T00:00:00Z', true),
        (${tiedActiveId}, ${companyId}, ${environmentId}, 'active', 'reuse_by_environment', 'coder', 'status-tie', '2026-08-03T00:00:00Z', false)
    `;

    await applyPendingMigrations(database.connectionString);

    const owners = await sql<{ id: string; provider_lease_id: string }[]>`
      SELECT "id", "provider_lease_id"
      FROM "environment_leases"
      WHERE "company_id" = ${companyId}
        AND "reusable_resource_owner" = true
      ORDER BY "provider_lease_id"
    `;
    expect(owners).toEqual([
      { id: newerReleasedId, provider_lease_id: "chronology" },
      { id: tiedActiveId, provider_lease_id: "status-tie" },
    ]);
  }, 30_000);
});
