import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, goals, heartbeatRuns, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list routes assigneeAgentId filter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(goals);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }


  function uniqueIssuePrefix() {
    return `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCloudTenantMember(companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  it("returns only unassigned issues for assigneeAgentId=null", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const unassignedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: unassignedIssueId,
        companyId,
        title: "Unassigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", assigneeAgentId: "null", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([unassignedIssueId]);
  });

  it("keeps UUID assignee filtering behavior unchanged", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: otherAgentId,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", assigneeAgentId, limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((issue: { id: string }) => issue.id)).toEqual([assignedIssueId]);
  });

  it("returns 422 for malformed assigneeAgentId filters", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", assigneeAgentId: "bad", limit: "20" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "assigneeAgentId must be a UUID or 'null'",
    });
  });

  /**
   * Regression test: the route accepted `priority`, `goalId`, and
   * `createdByAgentId` query params (Express parsed them into `req.query`
   * fine) but never forwarded them into the `svc.list()` filters object, so
   * every value — including one matching no row — fell through to the
   * unfiltered default list. Exercises the full HTTP route (not just the
   * service function `issues-service.test.ts` covers) to prove the
   * route→service wiring itself is fixed, not just the service in isolation.
   */
  it("filters by priority, goalId, and createdByAgentId query params", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const goalId = randomUUID();
    const matchingIssueId = randomUUID();
    const otherPriorityIssueId = randomUUID();
    const otherGoalIssueId = randomUUID();
    const otherCreatorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Target goal",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "Creator",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: matchingIssueId,
        companyId,
        goalId,
        title: "Matches all three filters",
        status: "todo",
        priority: "low",
        createdByAgentId: creatorAgentId,
      },
      {
        id: otherPriorityIssueId,
        companyId,
        goalId,
        title: "Wrong priority",
        status: "todo",
        priority: "critical",
        createdByAgentId: creatorAgentId,
      },
      {
        id: otherGoalIssueId,
        companyId,
        title: "No goal",
        status: "todo",
        priority: "low",
        createdByAgentId: creatorAgentId,
      },
      {
        id: otherCreatorIssueId,
        companyId,
        goalId,
        title: "Wrong creator",
        status: "todo",
        priority: "low",
        createdByAgentId: otherAgentId,
      },
    ]);

    const app = createApp(companyId);

    const byPriority = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", priority: "low", limit: "20" });
    expect(byPriority.status, JSON.stringify(byPriority.body)).toBe(200);
    expect(byPriority.body.map((issue: { id: string }) => issue.id).sort()).toEqual(
      [matchingIssueId, otherGoalIssueId, otherCreatorIssueId].sort(),
    );

    const byGoal = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", goalId, limit: "20" });
    expect(byGoal.status, JSON.stringify(byGoal.body)).toBe(200);
    expect(byGoal.body.map((issue: { id: string }) => issue.id).sort()).toEqual(
      [matchingIssueId, otherPriorityIssueId, otherCreatorIssueId].sort(),
    );

    const byCreator = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", createdByAgentId: creatorAgentId, limit: "20" });
    expect(byCreator.status, JSON.stringify(byCreator.body)).toBe(200);
    expect(byCreator.body.map((issue: { id: string }) => issue.id).sort()).toEqual(
      [matchingIssueId, otherPriorityIssueId, otherGoalIssueId].sort(),
    );

    // Bogus goalId (matching no real row) must return zero rows, not the
    // unfiltered default list — the exact contrast the original bug
    // report used to distinguish "ignored" from "working".
    const bogusGoal = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "todo", goalId: randomUUID(), limit: "20" });
    expect(bogusGoal.status, JSON.stringify(bogusGoal.body)).toBe(200);
    expect(bogusGoal.body).toEqual([]);
  });

  it("rejects malformed or repeated UUID issue filters before querying", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    const app = createApp(companyId);

    for (const path of ["issues", "issues/count?attention=blocked"]) {
      const separator = path.includes("?") ? "&" : "?";
      const repeatedGoal = await request(app)
        .get(`/api/companies/${companyId}/${path}${separator}goalId=${randomUUID()}&goalId=${randomUUID()}`);
      expect(repeatedGoal.status).toBe(422);
      expect(repeatedGoal.body).toMatchObject({ error: "goalId must be a UUID" });

      const malformedCreator = await request(app)
        .get(`/api/companies/${companyId}/${path}${separator}createdByAgentId=bad`);
      expect(malformedCreator.status).toBe(422);
      expect(malformedCreator.body).toMatchObject({ error: "createdByAgentId must be a UUID" });
    }
  });

  it("applies goal, creator, and priority filters to blocked issue counts", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const goalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Target goal",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "Creator",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        goalId,
        title: "Matching blocked issue",
        description: "Blocked on an external decision.",
        status: "blocked",
        priority: "high",
        createdByAgentId: creatorAgentId,
      },
      {
        id: randomUUID(),
        companyId,
        goalId,
        title: "Wrong creator",
        description: "Blocked on an external decision.",
        status: "blocked",
        priority: "high",
        createdByAgentId: otherAgentId,
      },
    ]);

    const res = await request(createApp(companyId))
      .get(`/api/companies/${companyId}/issues/count`)
      .query({
        attention: "blocked",
        goalId,
        createdByAgentId: creatorAgentId,
        priority: "high",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ count: 1 });
  });

  it("returns opt-in live descendant counts for offscreen live descendants only", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const hiddenChildIssueId = randomUUID();
    const crossCompanyChildIssueId = randomUUID();
    const rootRunId = randomUUID();
    const grandchildRunId = randomUUID();
    const hiddenRunId = randomUUID();
    const crossCompanyRunId = randomUUID();

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: uniqueIssuePrefix(),
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Company",
        issuePrefix: uniqueIssuePrefix(),
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: rootRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: rootIssueId },
      },
      {
        id: grandchildRunId,
        companyId,
        agentId,
        status: "queued",
        contextSnapshot: { issueId: grandchildIssueId },
      },
      {
        id: hiddenRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: hiddenChildIssueId },
      },
      {
        id: crossCompanyRunId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        status: "running",
        contextSnapshot: { issueId: crossCompanyChildIssueId },
      },
    ]);
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "critical",
        executionRunId: rootRunId,
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        title: "Offscreen child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        assigneeAgentId: agentId,
      },
      {
        id: grandchildIssueId,
        companyId,
        title: "Offscreen live grandchild",
        status: "todo",
        priority: "medium",
        parentId: childIssueId,
        executionRunId: grandchildRunId,
        assigneeAgentId: agentId,
      },
      {
        id: hiddenChildIssueId,
        companyId,
        title: "Hidden live child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        executionRunId: hiddenRunId,
        hiddenAt: new Date("2026-07-02T00:00:00.000Z"),
        assigneeAgentId: agentId,
      },
      {
        id: crossCompanyChildIssueId,
        companyId: otherCompanyId,
        title: "Cross-company live child",
        status: "todo",
        priority: "medium",
        parentId: rootIssueId,
        executionRunId: crossCompanyRunId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    const app = createApp(companyId);
    const withoutSummary = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", limit: "20" });

    expect(withoutSummary.status, JSON.stringify(withoutSummary.body)).toBe(200);
    expect(withoutSummary.body).toHaveLength(1);
    expect(withoutSummary.body[0].id).toBe(rootIssueId);
    expect(withoutSummary.body[0].liveDescendantCount).toBeUndefined();

    const withSummary = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", includeLiveDescendantSummary: "true", limit: "20" });

    expect(withSummary.status, JSON.stringify(withSummary.body)).toBe(200);
    expect(withSummary.body).toHaveLength(1);
    expect(withSummary.body[0]).toMatchObject({
      id: rootIssueId,
      liveDescendantCount: 1,
    });
  });

  it("does not recurse forever when live descendant summaries encounter a parent cycle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: childIssueId },
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Cycle parent",
        status: "blocked",
        priority: "medium",
        parentId: childIssueId,
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        title: "Cycle live child",
        status: "in_progress",
        priority: "medium",
        parentId: parentIssueId,
        executionRunId: runId,
        assigneeAgentId: agentId,
      },
    ]);

    const app = createApp(companyId);
    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ status: "blocked", includeLiveDescendantSummary: "true", limit: "20" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: parentIssueId,
      liveDescendantCount: 1,
    });
  });
});
