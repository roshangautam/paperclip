import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environments,
  environmentLeases,
  heartbeatRuns,
  toolInvocations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent delete guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service remove — pending lease-release guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-delete-guard-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(toolInvocations);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(): Promise<{
    companyId: string;
    agentId: string;
    runId: string;
    environmentId: string;
    leaseId: string;
    invocationId: string;
  }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const environmentId = randomUUID();
    const leaseId = randomUUID();
    const invocationId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      logStore: "local_disk",
      finishedAt: new Date(),
    });
    await db.insert(environments).values({
      id: environmentId,
      name: "sandbox-env",
      driver: "sandbox",
      status: "active",
      config: {},
      envVars: {},
    });
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      environmentId,
      heartbeatRunId: runId,
      status: "active",
    });
    await db.insert(toolInvocations).values({
      id: invocationId,
      companyId,
      agentId,
      runId,
      toolName: "mcp:update_note",
      leaseReleasePendingAt: new Date(),
    });
    return { companyId, agentId, runId, environmentId, leaseId, invocationId };
  }

  it("blocks deletion while an owned run has an active lease and pending marker, leaving all rows intact", async () => {
    const { agentId, runId, leaseId, invocationId } = await seed();

    await expect(agentService(db).remove(agentId)).rejects.toMatchObject({
      details: { code: "agent_delete_blocked_by_pending_lease_release" },
    });

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [runRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [leaseRow] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    const [invocationRow] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, invocationId));
    expect(agentRow).toBeDefined();
    expect(runRow).toBeDefined();
    expect(leaseRow?.heartbeatRunId).toBe(runId);
    expect(invocationRow?.leaseReleasePendingAt).toBeInstanceOf(Date);
  });

  it("allows deletion once the lease is released and the marker is cleared", async () => {
    const { agentId, leaseId, invocationId } = await seed();
    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, leaseId));
    await db.update(toolInvocations).set({ leaseReleasePendingAt: null }).where(eq(toolInvocations.id, invocationId));

    const removed = await agentService(db).remove(agentId);
    expect(removed?.id).toBe(agentId);
    const remaining = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(remaining).toHaveLength(0);
  });
});
