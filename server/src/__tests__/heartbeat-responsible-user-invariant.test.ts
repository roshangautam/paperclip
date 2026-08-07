import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  routines,
  routineRevisions,
  routineRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Responsible-user invariant test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

async function deleteHeartbeatRunsAfterEvents(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt < 4 &&
        message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
  }
}

describeEmbeddedPostgres("heartbeat responsible-user invariant", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-responsible-user-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and that run can dispatch a follow-up wakeup, so a run or
    // wakeup can still write heartbeat_runs and issues rows when teardown starts
    // and would race the deletes. The shared drain also awaits an in-flight
    // wakeup that is still before run registration, which a plain run table
    // status poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await deleteHeartbeatRunsAfterEvents(db);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(routineRuns);
    await db.delete(routineRevisions);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedCompany() {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    return { companyId, ownerUserId, agentId };
  }

  it("uses the issue responsible user for comment, mention, and dependency wakes", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueResponsibleUserId = `issue-owner-${randomUUID()}`;
    const commenterUserId = `commenter-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue-owned work",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: issueResponsibleUserId,
    });

    for (const wakeReason of ["issue_commented", "issue_comment_mentioned", "issue_blockers_resolved"]) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: wakeReason,
        payload: { issueId, commentId: randomUUID() },
        requestedByActorType: "user",
        requestedByActorId: commenterUserId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason },
      });
      expect(run).not.toBeNull();
      const completed = await waitForRun(db, run!.id);
      expect(completed?.responsibleUserId).toBe(issueResponsibleUserId);
    }
  });

  it("keeps a deferred-start wakeup queued until explicitly started", async () => {
    const { companyId, ownerUserId, agentId } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queue before routine commit",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: ownerUserId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      contextSnapshot: { issueId },
      deferStart: true,
    });

    expect(run?.status).toBe("queued");
    await expect(
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id)).then((rows) => rows[0]),
    ).resolves.toMatchObject({ status: "queued" });
    await heartbeat.startQueuedRunsForAgent(agentId);
    await expect(waitForRun(db, run!.id)).resolves.toMatchObject({ status: "succeeded" });
  });

  it.each(["issueId", "taskId"] as const)("waits for concurrent routine-run ownership repair before claiming a %s context", async (contextIssueKey) => {
    const { companyId, ownerUserId, agentId } = await seedCompany();
    const legacyResponsibleUserId = "built-in-bundles";
    const routineId = randomUUID();
    const routineRevisionId = randomUUID();
    const routineRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Repaired built-in routine",
      assigneeAgentId: agentId,
      responsibleUserId: legacyResponsibleUserId,
    });
    await db.insert(routineRevisions).values({
      id: routineRevisionId,
      companyId,
      routineId,
      revisionNumber: 1,
      title: "Legacy built-in routine revision",
      responsibleUserId: legacyResponsibleUserId,
      snapshot: {
        version: 1,
        routine: {
          id: routineId,
          companyId,
          projectId: null,
          goalId: null,
          parentIssueId: null,
          title: "Legacy built-in routine revision",
          description: null,
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          originKind: "built_in_bundle",
          originId: "recent-agent-reflection",
          variables: [],
          env: null,
          responsibleUserId: legacyResponsibleUserId,
        },
        triggers: [],
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Legacy routine execution",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: legacyResponsibleUserId,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: routineRunId,
    });
    await db.insert(routineRuns).values({
      id: routineRunId,
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
      routineRevisionId,
      responsibleUserId: legacyResponsibleUserId,
      linkedIssueId: issueId,
    });
    const [queuedRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      responsibleUserId: legacyResponsibleUserId,
      contextSnapshot: {
        [contextIssueKey]: issueId,
        source: "routine.dispatch",
        responsibleUserId: legacyResponsibleUserId,
      },
    }).returning();

    let claimReachedRoutineLock!: () => void;
    const reachedRoutineLock = new Promise<void>((resolve) => { claimReachedRoutineLock = resolve; });
    const racingHeartbeat = heartbeatService(db, {
      beforeClaimRoutineLock: async () => { claimReachedRoutineLock(); },
    });

    let finishAdapter!: () => void;
    const adapterCanFinish = new Promise<void>((resolve) => { finishAdapter = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await adapterCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Responsible-user invariant test run.",
        provider: "test",
        model: "test-model",
      };
    });

    let repairCanCommit!: () => void;
    const canCommit = new Promise<void>((resolve) => { repairCanCommit = resolve; });
    let repairUpdated!: () => void;
    const updated = new Promise<void>((resolve) => { repairUpdated = resolve; });
    const repairing = db.transaction(async (tx) => {
      await tx.update(routines).set({
        responsibleUserId: ownerUserId,
        updatedAt: new Date(),
      }).where(eq(routines.id, routineId));
      await tx.update(routineRuns).set({
        responsibleUserId: ownerUserId,
        updatedAt: new Date(),
      }).where(eq(routineRuns.id, routineRunId));
      repairUpdated();
      await canCommit;
    });

    try {
      await updated;
      const resuming = racingHeartbeat.resumeQueuedRuns();
      await reachedRoutineLock;
      repairCanCommit();
      await repairing;
      await resuming;
      const claimed = await db.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRun!.id)).then((rows) => rows[0]);
      expect(claimed).toMatchObject({ status: "running", responsibleUserId: ownerUserId });
      if (contextIssueKey === "taskId") {
        expect(claimed?.contextSnapshot).toMatchObject({ issueId, taskId: issueId });
      }
    } finally {
      repairCanCommit();
      finishAdapter();
    }
    const completed = await waitForRun(db, queuedRun!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
    expect(completed?.responsibleUserId).not.toBe(legacyResponsibleUserId);
  });

  it("preserves a non-UUID task key without treating it as an issue", async () => {
    const { agentId, ownerUserId } = await seedCompany();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "task_scoped_work",
      requestedByActorType: "system",
      contextSnapshot: { taskId: "task-123" },
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed).toMatchObject({ status: "succeeded", responsibleUserId: ownerUserId });
    expect(completed?.contextSnapshot).toMatchObject({ taskId: "task-123" });
    expect(completed?.contextSnapshot).not.toHaveProperty("issueId");
  });

  it("uses the triggering user for manual UI/API runs", async () => {
    const { agentId } = await seedCompany();
    const triggeringUserId = `manual-${randomUUID()}`;
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: triggeringUserId,
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(triggeringUserId);
  });

  it("falls back to the company default for system-originated runs without an issue", async () => {
    const { agentId, ownerUserId } = await seedCompany();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "productivity_review",
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: { wakeReason: "productivity_review" },
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
  });

  it("does not use an issue creator as an implicit responsible user for automated issue runs", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const creatorUserId = `creator-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator is not credential owner",
      status: "todo",
      assigneeAgentId: agentId,
      createdByUserId: creatorUserId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
    expect(completed?.responsibleUserId).not.toBe(creatorUserId);
  });

  it("fails automated issue dispatch instead of falling back to the issue creator when no default exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Creator-only",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator-only issue",
      status: "todo",
      assigneeAgentId: agentId,
      createdByUserId: `creator-${randomUUID()}`,
    });

    await expect(heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(0);
  });

  it("fails dispatch before creating a run when no responsible user can be resolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ownerless",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });

    await expect(heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      requestedByActorType: "system",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(0);
  });
});
