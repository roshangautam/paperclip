import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  getSandbox: vi.fn(),
}));

import bridgeWorker from "./index.js";
import { shellQuote } from "./helpers.js";
import { handleBridgeRequest } from "./routes.js";
import {
  buildSentinelPath,
  DEFAULT_REMOTE_CWD,
  resolveSandbox,
  type LeaseOwnershipClaim,
  type LeaseOwnershipIdentity,
  type LeaseOwnershipRecord,
} from "./sandboxes.js";

vi.mock("./sandboxes.js", async () => {
  const actual = await vi.importActual<typeof import("./sandboxes.js")>("./sandboxes.js");
  return { ...actual, resolveSandbox: vi.fn() };
});

function bridgeRequest(pathname: string, body: unknown, method = "POST"): Request {
  return new Request(`https://bridge.example.test${pathname}`, {
    method,
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function ownership(
  providerLeaseId = "pc-acq-acquisition-1",
  acquisitionId = "acquisition-1",
): LeaseOwnershipRecord {
  return {
    version: 1,
    providerLeaseId,
    acquisitionId,
    acquisitionFingerprint: "fingerprint-one",
    state: "owned",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

function matches(record: LeaseOwnershipRecord, identity: LeaseOwnershipIdentity): boolean {
  return record.providerLeaseId === identity.providerLeaseId
    && record.acquisitionId === identity.acquisitionId;
}

function createSandbox(options: {
  ownership?: LeaseOwnershipRecord | "invalid" | null;
  sessionExec?: ReturnType<typeof vi.fn>;
  destroy?: ReturnType<typeof vi.fn>;
} = {}) {
  let current = options.ownership ?? null;
  const completed = new Set<string>();
  const liveLeaseExecutions = new Set<string>();
  let destructionInFlight: Promise<unknown> | null = null;
  const identityKey = (identity: LeaseOwnershipIdentity) => `${identity.providerLeaseId}:${identity.acquisitionId}`;
  const sessionExec = options.sessionExec ?? vi.fn().mockImplementation(async (command: string) => ({
    exitCode: 0,
    stdout: command.includes("test ! -e") && current && current !== "invalid"
      ? JSON.stringify({
          providerLeaseId: current.providerLeaseId,
          acquisitionId: current.acquisitionId,
          acquisitionFingerprint: current.acquisitionFingerprint,
          remoteCwd: DEFAULT_REMOTE_CWD,
        })
      : "",
    stderr: "",
  }));
  const sandbox = {
    exec: sessionExec,
    getSession: vi.fn().mockResolvedValue({ exec: sessionExec }),
    createSession: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    setKeepAlive: vi.fn().mockResolvedValue(undefined),
    destroy: options.destroy ?? vi.fn().mockResolvedValue(undefined),
    readContainerState: vi.fn().mockResolvedValue({ status: "healthy", lastChange: 0 }),
    readLeaseOwnership: vi.fn(async () => {
      if (current === null) return { status: "missing" } as const;
      if (current === "invalid") return { status: "invalid" } as const;
      return { status: current.state, ownership: current } as const;
    }),
    claimLeaseOwnership: vi.fn(async (claim: LeaseOwnershipClaim) => {
      if (current === "invalid") return { status: "invalid" } as const;
      if (current === null) {
        const setupExecution = claim.setupExecutionId && claim.setupExpiresAt
          ? [{ executionId: claim.setupExecutionId, expiresAt: claim.setupExpiresAt }]
          : undefined;
        current = {
          version: 1,
          providerLeaseId: claim.providerLeaseId,
          acquisitionId: claim.acquisitionId,
          acquisitionFingerprint: claim.acquisitionFingerprint,
          state: "owned",
          setupComplete: setupExecution === undefined,
          activeExecutions: setupExecution,
          updatedAt: new Date().toISOString(),
        };
        if (claim.setupExecutionId) liveLeaseExecutions.add(claim.setupExecutionId);
        return { status: "claimed", ownership: current } as const;
      }
      if (current.state === "destroying") return { status: "destroying", ownership: current } as const;
      if (!matches(current, claim) || current.acquisitionFingerprint !== claim.acquisitionFingerprint) {
        return { status: "conflict", ownership: current } as const;
      }
      if (current.setupComplete !== false) return { status: "replayed", ownership: current } as const;
      const activeExecutions = (current.activeExecutions ?? [])
        .filter((execution) => Date.parse(execution.expiresAt) > Date.now());
      if (activeExecutions.length > 0 || !claim.setupExecutionId || !claim.setupExpiresAt) {
        return { status: "in_progress", ownership: { ...current, activeExecutions } } as const;
      }
      current = {
        ...current,
        activeExecutions: [{ executionId: claim.setupExecutionId, expiresAt: claim.setupExpiresAt }],
        updatedAt: new Date().toISOString(),
      };
      liveLeaseExecutions.add(claim.setupExecutionId);
      return { status: "claimed", ownership: current } as const;
    }),
    updateLeaseOwnership: vi.fn(async (identity: LeaseOwnershipIdentity) => {
      if (current === null) return { status: "missing" } as const;
      if (current === "invalid") return { status: "invalid" } as const;
      if (!matches(current, identity)) return { status: "conflict", ownership: current } as const;
      if (current.state === "destroying") return { status: "destroying", ownership: current } as const;
      current = { ...current, updatedAt: new Date().toISOString() };
      return { status: "updated", ownership: current } as const;
    }),
    beginLeaseExecution: vi.fn(async (identity: LeaseOwnershipIdentity, executionId: string, expiresAt: string) => {
      if (current === null) return { status: "missing" } as const;
      if (current === "invalid") return { status: "invalid" } as const;
      if (!matches(current, identity)) return { status: "conflict", ownership: current } as const;
      if (current.state === "destroying") return { status: "destroying", ownership: current } as const;
      const activeExecutions = (current.activeExecutions ?? [])
        .filter((execution) => Date.parse(execution.expiresAt) > Date.now());
      if (activeExecutions.some((execution) => execution.executionId === executionId)) {
        liveLeaseExecutions.add(executionId);
        return { status: "replayed", ownership: current } as const;
      }
      if (current.setupComplete === false) {
        return { status: "conflict", ownership: current } as const;
      }
      current = {
        ...current,
        activeExecutions: [...activeExecutions, { executionId, expiresAt }],
        updatedAt: new Date().toISOString(),
      };
      liveLeaseExecutions.add(executionId);
      return { status: "started", ownership: current } as const;
    }),
    renewLeaseExecution: vi.fn(async (identity: LeaseOwnershipIdentity, executionId: string, expiresAt: string) => {
      if (current === null) return { status: "missing" } as const;
      if (current === "invalid") return { status: "invalid" } as const;
      if (!matches(current, identity)) return { status: "conflict", ownership: current } as const;
      if (!(current.activeExecutions ?? []).some((execution) => execution.executionId === executionId)) {
        return { status: "missing" } as const;
      }
      current = {
        ...current,
        activeExecutions: (current.activeExecutions ?? []).map((execution) => (
          execution.executionId === executionId ? { executionId, expiresAt } : execution
        )),
        updatedAt: new Date().toISOString(),
      };
      return { status: "renewed", ownership: current } as const;
    }),
    quarantineLeaseExecution: vi.fn(async (
      identity: LeaseOwnershipIdentity,
      executionId: string,
      destructionId: string,
    ) => {
      if (current === null) return { status: "missing" } as const;
      if (current === "invalid") return { status: "invalid" } as const;
      if (!matches(current, identity)) return { status: "conflict", ownership: current } as const;
      if (!(current.activeExecutions ?? []).some((execution) => execution.executionId === executionId)) {
        return { status: "missing" } as const;
      }
      if (current.state === "destroying") return { status: "in_progress", ownership: current } as const;
      current = {
        ...current,
        state: "destroying",
        destructionId,
        updatedAt: new Date().toISOString(),
      };
      return { status: "quarantined", ownership: current } as const;
    }),
    completeLeaseExecution: vi.fn(async (
      identity: LeaseOwnershipIdentity,
      executionId: string,
      completeSetup = false,
    ) => {
      try {
        if (current === null) return { status: "missing" } as const;
        if (current === "invalid") return { status: "invalid" } as const;
        if (!matches(current, identity)) return { status: "conflict", ownership: current } as const;
        const executions = current.activeExecutions ?? [];
        if (!executions.some((execution) => execution.executionId === executionId)) {
          return { status: "missing" } as const;
        }
        const activeExecutions = executions
          .filter((execution) => execution.executionId !== executionId);
        current = {
          ...current,
          activeExecutions,
          setupComplete: completeSetup ? true : current.setupComplete,
          updatedAt: new Date().toISOString(),
        };
        if (current.state === "destroying" && activeExecutions.length === 0) {
          return { status: "destruction_started", ownership: current } as const;
        }
        return { status: "completed", ownership: current } as const;
      } finally {
        liveLeaseExecutions.delete(executionId);
      }
    }),
    beginLeaseDestructionAfterExecution: vi.fn(async (
      identity: LeaseOwnershipIdentity,
      executionId: string,
      destructionId: string,
    ) => {
      try {
        if (completed.has(identityKey(identity))) return { status: "completed" } as const;
        if (current === null) return { status: "missing" } as const;
        if (current === "invalid") return { status: "invalid" } as const;
        if (!matches(current, identity)) return { status: "conflict", ownership: current } as const;
        if (!(current.activeExecutions ?? []).some((execution) => execution.executionId === executionId)) {
          return current.state === "destroying"
            ? { status: "in_progress", ownership: current } as const
            : { status: "missing" } as const;
        }
        const activeExecutions = (current.activeExecutions ?? [])
          .filter((execution) => execution.executionId !== executionId);
        current = {
          ...current,
          state: "destroying",
          destructionId: current.state === "destroying" ? current.destructionId : destructionId,
          activeExecutions,
          updatedAt: new Date().toISOString(),
        };
        return activeExecutions.length > 0
          ? { status: "in_progress", ownership: current } as const
          : { status: "started", ownership: current } as const;
      } finally {
        liveLeaseExecutions.delete(executionId);
      }
    }),
    beginLeaseDestruction: vi.fn(async (identity: LeaseOwnershipIdentity, destructionId: string) => {
      if (completed.has(identityKey(identity))) return { status: "completed" } as const;
      if (current === null) return { status: "missing" } as const;
      if (current === "invalid") return { status: "invalid" } as const;
      if (!matches(current, identity)) return { status: "conflict", ownership: current } as const;
      if (liveLeaseExecutions.size > 0) return { status: "in_progress", ownership: current } as const;
      const executions = current.activeExecutions ?? [];
      const activeExecutions = executions.filter((execution) => Date.parse(execution.expiresAt) > Date.now());
      if (current.state === "destroying") {
        current = { ...current, activeExecutions, updatedAt: new Date().toISOString() };
        return { status: "in_progress", ownership: current } as const;
      }
      if (activeExecutions.length > 0) {
        current = { ...current, activeExecutions, updatedAt: new Date().toISOString() };
        return { status: "in_progress", ownership: current } as const;
      }
      current = { ...current, activeExecutions, state: "destroying", destructionId, updatedAt: new Date().toISOString() };
      return { status: "started", ownership: current } as const;
    }),
    completeLeaseDestruction: vi.fn(async (identity: LeaseOwnershipIdentity, destructionId: string) => {
      if (current === null) {
        return completed.has(identityKey(identity)) ? { status: "completed" } as const : { status: "missing" } as const;
      }
      if (current === "invalid") return { status: "invalid" } as const;
      if (!matches(current, identity)) return { status: "conflict", ownership: current } as const;
      if (current.state !== "destroying" || current.destructionId !== destructionId) {
        return { status: "conflict", ownership: current } as const;
      }
      completed.add(identityKey(identity));
      current = null;
      return { status: "completed" } as const;
    }),
    destroyLease: vi.fn(async (
      identity: LeaseOwnershipIdentity,
      destructionId: string,
      executionId?: string,
    ) => {
      if (destructionInFlight) return await destructionInFlight;
      destructionInFlight = (async () => {
        const destruction = executionId
          ? await sandbox.beginLeaseDestructionAfterExecution(identity, executionId, destructionId)
          : await sandbox.beginLeaseDestruction(identity, destructionId);
        if (destruction.status === "completed") return destruction;
        if (destruction.status !== "started") {
          if (
            destruction.status !== "in_progress"
            || destruction.ownership.state !== "destroying"
            || (destruction.ownership.activeExecutions?.length ?? 0) > 0
          ) {
            return destruction;
          }
        }
        const persistedDestructionId = destruction.ownership.destructionId;
        if (!persistedDestructionId) return { status: "invalid" } as const;
        await sandbox.destroy();
        const finalized = await sandbox.completeLeaseDestruction(identity, persistedDestructionId);
        return finalized.status === "completed" ? { status: "destroyed" } as const : finalized;
      })();
      try {
        return await destructionInFlight;
      } finally {
        destructionInFlight = null;
      }
    }),
  };
  return { sandbox, sessionExec, getOwnership: () => current };
}

function acquireBody(acquisitionId = "acquisition-1") {
  return {
    acquisitionId,
    environmentId: "env-1",
    runId: "run-1",
    requestedCwd: "/workspace/paperclip",
    sessionStrategy: "named",
    sessionId: "paperclip",
  };
}

describe("bridge routes", () => {
  beforeEach(() => {
    vi.mocked(resolveSandbox).mockReset();
  });

  it("advertises replay-safe acquisition support", async () => {
    const response = await handleBridgeRequest(
      new Request("https://bridge.example.test/api/paperclip-sandbox/v1/health", {
        headers: { Authorization: "Bearer secret-token" },
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(await response.json()).toMatchObject({
      capabilities: { acquisitionReplay: true, scopedReuse: true },
    });
  });

  it("uses distinct sandbox IDs for probes started in the same millisecond", async () => {
    const { sandbox } = createSandbox({
      sessionExec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "/workspace/paperclip\n", stderr: "" }),
    });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(123);

    await Promise.all([
      handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v1/probe", {}),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      ),
      handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v1/probe", {}),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      ),
    ]);
    dateNow.mockRestore();

    const sandboxIds = vi.mocked(resolveSandbox).mock.calls.map((call) => call[1]);
    expect(sandboxIds[0]).toMatch(/^pc-acq-probe-123-/);
    expect(sandboxIds[1]).toMatch(/^pc-acq-probe-123-/);
    expect(sandboxIds[0]).not.toBe(sandboxIds[1]);
  });

  it("claims ownership before writing the filesystem mirror", async () => {
    const { sandbox, sessionExec } = createSandbox();
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(sandbox.claimLeaseOwnership).toHaveBeenCalledWith(expect.objectContaining({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "acquisition-1",
      acquisitionFingerprint: expect.any(String),
      setupExecutionId: expect.any(String),
      setupExpiresAt: expect.any(String),
    }));
    expect(sandbox.claimLeaseOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      sessionExec.mock.invocationCallOrder[0]!,
    );
    expect(sessionExec).toHaveBeenCalledOnce();
    expect(sessionExec.mock.calls[0]?.[0]).toContain("/workspace/paperclip/.paperclip-lease.json");
    expect(sessionExec.mock.calls[0]?.[0]).toContain("acquisition-1");
    expect(sessionExec.mock.calls[0]?.[0]).toContain(".pending.");
    expect(sessionExec.mock.calls[0]?.[0]).toContain("mv ");
  });

  it("uses a quoted variable in the ownership-mirror cleanup trap", async () => {
    const executionId = "00000000-0000-4000-8000-000000000001";
    const pendingId = "00000000-0000-4000-8000-000000000002";
    const remoteCwd = "/workspace/paper clip's;touch /tmp/pwned";
    const randomUUID = vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(executionId)
      .mockReturnValueOnce(pendingId);
    const { sandbox, sessionExec } = createSandbox();
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    try {
      const response = await handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
          ...acquireBody(),
          requestedCwd: remoteCwd,
        }),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      );

      expect(response.status).toBe(200);
      const pendingPath = `${buildSentinelPath(remoteCwd)}.pending.${pendingId}`;
      const pendingPathAssignment = `pending_path=${shellQuote(pendingPath)}`;
      const trap = `trap 'rm -f -- "$pending_path"' EXIT`;
      const nestedShellQuote = (value: string) => value.replace(/'/g, `'"'"'`);
      expect(String(sessionExec.mock.calls[0]?.[0])).toContain(
        nestedShellQuote(nestedShellQuote(pendingPathAssignment)),
      );
      expect(String(sessionExec.mock.calls[0]?.[0])).toContain(nestedShellQuote(nestedShellQuote(trap)));
    } finally {
      randomUUID.mockRestore();
    }
  });

  it("blocks lease destruction while acquisition setup is active", async () => {
    let finishSetup!: () => void;
    const setupFinished = new Promise<void>((resolve) => { finishSetup = resolve; });
    const sessionExec = vi.fn(async () => {
      await setupFinished;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const { sandbox } = createSandbox({ sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const acquireResponse = handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    await vi.waitFor(() => expect(sessionExec).toHaveBeenCalledOnce());

    const concurrentReplay = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(concurrentReplay.status).toBe(503);
    expect(await concurrentReplay.json()).toMatchObject({
      error: "acquisition_in_progress",
      details: { providerLeaseId: "pc-acq-acquisition-1" },
    });
    expect(sandbox.setKeepAlive).toHaveBeenCalledOnce();
    expect(sandbox.beginLeaseExecution).not.toHaveBeenCalled();

    const blockedDestroy = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(blockedDestroy.status).toBe(409);
    expect(sandbox.destroy).not.toHaveBeenCalled();

    finishSetup();
    expect((await acquireResponse).status).toBe(200);
    const completedReplay = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(completedReplay.status).toBe(200);
    expect(sandbox.setKeepAlive).toHaveBeenCalledOnce();
    expect(sandbox.beginLeaseExecution).not.toHaveBeenCalled();
    const retryDestroy = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(retryDestroy.status).toBe(200);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("replays an acquisition and rejects a different acquisition for the same lease", async () => {
    const { sandbox } = createSandbox();
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);
    const reusable = {
      ...acquireBody(),
      reuseLease: true,
      reuseScopeId: "0123456789abcdef0123456789abcdef",
    };

    const first = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", reusable),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    const replay = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", reusable),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    const conflict = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
        ...acquireBody("acquisition-2"),
        reuseLease: true,
        reuseScopeId: reusable.reuseScopeId,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "acquisition_conflict" });
    expect(sandbox.setKeepAlive).toHaveBeenCalledOnce();
  });

  it("rejects reusable acquisitions without a valid scope", async () => {
    for (const reuseScopeId of [undefined, "not-a-scope"]) {
      const response = await handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
          ...acquireBody(),
          reuseLease: true,
          reuseScopeId,
        }),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    }
    expect(resolveSandbox).not.toHaveBeenCalled();
  });

  it("rejects changed setup parameters when replaying an existing acquisition", async () => {
    const { sandbox, sessionExec } = createSandbox();
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const first = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(first.status).toBe(200);

    sandbox.setKeepAlive.mockClear();
    sessionExec.mockClear();
    const changedReplay = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", {
        ...acquireBody(),
        requestedCwd: "/workspace/other",
        keepAlive: true,
        sleepAfter: "1h",
        sessionId: "other-session",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(changedReplay.status).toBe(409);
    expect(await changedReplay.json()).toMatchObject({ error: "acquisition_conflict" });
    expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
    expect(sessionExec).not.toHaveBeenCalled();
  });

  it("rejects a replay whose provider lease ID differs despite the same acquisition ID", async () => {
    const { sandbox } = createSandbox({
      ownership: ownership("pc-acq-foreign", "acquisition-1"),
    });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "acquisition_conflict" });
    expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
    expect(sandbox.claimLeaseOwnership).toHaveBeenCalledWith(expect.objectContaining({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "acquisition-1",
      acquisitionFingerprint: expect.any(String),
      setupExecutionId: expect.any(String),
      setupExpiresAt: expect.any(String),
    }));
  });

  it("does not expose a provider lease ID when the authoritative claim fails", async () => {
    const { sandbox } = createSandbox();
    sandbox.claimLeaseOwnership.mockRejectedValue(new Error("storage unavailable"));
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await bridgeWorker.fetch(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    const body = await response.json() as { details?: unknown };

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: "acquisition_failed", message: "storage unavailable" });
    expect(body).not.toHaveProperty("details");
    expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
  });

  it("destroys a claimed lease when later acquisition setup fails", async () => {
    const { sandbox } = createSandbox();
    sandbox.setKeepAlive.mockRejectedValue(new Error("permission denied"));
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await bridgeWorker.fetch(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(500);
    const body = await response.json() as { details?: unknown };
    expect(body).toMatchObject({ error: "acquisition_failed" });
    expect(body).not.toHaveProperty("details");
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("returns the claimed lease ID when failed acquisition cleanup must be retried", async () => {
    const { sandbox } = createSandbox();
    sandbox.setKeepAlive.mockRejectedValue(new Error("permission denied"));
    sandbox.destroy.mockRejectedValue(new Error("destroy unavailable"));
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await bridgeWorker.fetch(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "acquisition_failed",
      details: { providerLeaseId: "pc-acq-acquisition-1" },
    });
  });

  it.each(["", "{corrupt-json"])(
    "rejects a healthy container with missing or invalid sentinel contents %s",
    async (sentinelContents) => {
      const sessionExec = vi.fn().mockImplementation(async (command: string) => ({
        exitCode: 0,
        stdout: command.includes("test ! -e") ? sentinelContents : "",
        stderr: "",
      }));
      const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
      vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

      const response = await handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
          providerLeaseId: "pc-acq-acquisition-1",
          acquisitionId: "acquisition-1",
          requestedCwd: "/workspace/paperclip",
          keepAlive: true,
        }),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "sandbox_state_lost" });
      expect(sandbox.beginLeaseExecution).not.toHaveBeenCalled();
      expect(sandbox.completeLeaseExecution).not.toHaveBeenCalled();
      expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
      expect(sessionExec).toHaveBeenCalledOnce();
      expect(String(sessionExec.mock.calls[0]?.[0])).toContain("test ! -e");
      expect(String(sessionExec.mock.calls[0]?.[0])).not.toContain("acquisitionFingerprint");
    },
  );

  it("rejects oversized sentinel contents before resuming the lease", async () => {
    const sentinelContents = JSON.stringify({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "acquisition-1",
      acquisitionFingerprint: "fingerprint-1",
      remoteCwd: "/workspace/paperclip",
      padding: "x".repeat(4_096),
    });
    const sessionExec = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: sentinelContents,
      stderr: "",
    });
    const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        requestedCwd: "/workspace/paperclip",
        keepAlive: true,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "sandbox_state_lost" });
    expect(sandbox.beginLeaseExecution).not.toHaveBeenCalled();
    expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
    expect(sessionExec).toHaveBeenCalledOnce();
    expect(String(sessionExec.mock.calls[0]?.[0])).toContain("head -c 4097");
    expect(String(sessionExec.mock.calls[0]?.[0])).not.toContain("cat");
  });

  it.each([
    ["running", 200],
    ["healthy", 200],
    ["stopping", 409],
    ["stopped", 409],
    ["stopped_with_code", 409],
  ] as const)("handles resume when the container state is %s", async (status, expectedStatus) => {
    const { sandbox, sessionExec } = createSandbox({ ownership: ownership() });
    sandbox.readContainerState.mockResolvedValue({ status, lastChange: 0 });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        requestedCwd: DEFAULT_REMOTE_CWD,
        keepAlive: true,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(expectedStatus);
    if (expectedStatus === 200) {
      expect(sandbox.beginLeaseExecution).toHaveBeenCalledOnce();
      expect(sandbox.setKeepAlive).toHaveBeenCalledWith(true);
    } else {
      expect(await response.json()).toMatchObject({ error: "sandbox_state_lost" });
      expect(sandbox.beginLeaseExecution).not.toHaveBeenCalled();
      expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
      expect(sessionExec).not.toHaveBeenCalled();
    }
  });

  it("migrates a matching legacy sentinel only during resume", async () => {
    const sessionExec = vi.fn().mockImplementation(async (command: string) => ({
      exitCode: 0,
      stdout: command.includes("test ! -e")
        ? JSON.stringify({ providerLeaseId: "pc-acq-acquisition-1", remoteCwd: "/workspace/paperclip" })
        : "",
      stderr: "",
    }));
    const { sandbox } = createSandbox({ sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        requestedCwd: "/workspace/paperclip",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(sandbox.claimLeaseOwnership).toHaveBeenCalledWith({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "acquisition-1",
      acquisitionFingerprint: "legacy:pc-acq-acquisition-1",
    });
    expect(sessionExec.mock.calls.some(([command]) => String(command).includes("acquisitionFingerprint"))).toBe(true);
  });

  it("migrates a matching legacy sentinel when resume omits acquisitionId", async () => {
    const sessionExec = vi.fn().mockImplementation(async (command: string) => ({
      exitCode: 0,
      stdout: command.includes("test ! -e")
        ? JSON.stringify({ providerLeaseId: "pc-acq-acquisition-1", remoteCwd: "/workspace/paperclip" })
        : "",
      stderr: "",
    }));
    const { sandbox } = createSandbox({ sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const resume = () => handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        requestedCwd: "/workspace/paperclip",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    const response = await resume();
    const replay = await resume();

    expect([response.status, replay.status]).toEqual([200, 200]);
    expect(await response.json()).toMatchObject({
      metadata: { acquisitionId: "legacy:pc-acq-acquisition-1" },
    });
    expect(await replay.json()).toMatchObject({
      metadata: { acquisitionId: "legacy:pc-acq-acquisition-1" },
    });
    expect(sandbox.claimLeaseOwnership).toHaveBeenCalledWith({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "legacy:pc-acq-acquisition-1",
      acquisitionFingerprint: "legacy:pc-acq-acquisition-1",
    });
    expect(sandbox.claimLeaseOwnership).toHaveBeenCalledOnce();
    expect(sandbox.beginLeaseExecution).toHaveBeenCalledTimes(2);
    expect(sandbox.beginLeaseExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "legacy:pc-acq-acquisition-1",
      }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("rejects missing acquisitionId against modern authoritative ownership", async () => {
    const { sandbox, sessionExec } = createSandbox({ ownership: ownership() });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "sandbox_state_lost" });
    expect(sandbox.beginLeaseExecution).not.toHaveBeenCalled();
    expect(sessionExec).not.toHaveBeenCalled();
  });

  it("rejects missing acquisitionId against a modern sentinel", async () => {
    const sessionExec = vi.fn().mockImplementation(async (command: string) => ({
      exitCode: 0,
      stdout: command.includes("test ! -e")
        ? JSON.stringify({
            providerLeaseId: "pc-acq-acquisition-1",
            acquisitionId: "acquisition-1",
            acquisitionFingerprint: "fingerprint-one",
          })
        : "",
      stderr: "",
    }));
    const { sandbox } = createSandbox({ sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "sandbox_state_lost" });
    expect(sandbox.claimLeaseOwnership).not.toHaveBeenCalled();
  });

  it("preserves authoritative ownership across resume and replay", async () => {
    const { sandbox, sessionExec } = createSandbox();
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const first = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    const resume = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    const replay = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect([first.status, resume.status, replay.status]).toEqual([200, 200, 200]);
    expect(sandbox.claimLeaseOwnership).toHaveBeenCalledTimes(2);
    expect(sandbox.claimLeaseOwnership.mock.calls[1]?.[0]).toMatchObject({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "acquisition-1",
      acquisitionFingerprint: sandbox.claimLeaseOwnership.mock.calls[0]?.[0].acquisitionFingerprint,
    });
    expect(sessionExec.mock.calls.filter(([command]) => String(command).includes("acquisitionFingerprint"))).toHaveLength(2);
  });

  it("blocks lease destruction while resume setup is active", async () => {
    let finishSetup!: () => void;
    const setupFinished = new Promise<void>((resolve) => { finishSetup = resolve; });
    const sessionExec = vi.fn(async (command: string) => {
      if (command.includes("test ! -e")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            providerLeaseId: "pc-acq-acquisition-1",
            acquisitionId: "acquisition-1",
            acquisitionFingerprint: "fingerprint-one",
            remoteCwd: DEFAULT_REMOTE_CWD,
          }),
          stderr: "",
        };
      }
      if (sessionExec.mock.calls.length === 2) await setupFinished;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const resumeResponse = handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    await vi.waitFor(() => expect(sessionExec).toHaveBeenCalledTimes(2));

    const blockedDestroy = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(blockedDestroy.status).toBe(409);
    expect(sandbox.destroy).not.toHaveBeenCalled();

    finishSetup();
    expect((await resumeResponse).status).toBe(200);
    const retryDestroy = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(retryDestroy.status).toBe(200);
  });

  it("destroys a reusable lease when default-session resume setup times out", async () => {
    const sessionExec = vi.fn(async (command: string) => {
      if (command.includes("test ! -e")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            providerLeaseId: "pc-acq-acquisition-1",
            acquisitionId: "acquisition-1",
            acquisitionFingerprint: "fingerprint-one",
            remoteCwd: DEFAULT_REMOTE_CWD,
          }),
          stderr: "",
        };
      }
      throw new Error("command timed out");
    });
    const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await bridgeWorker.fetch(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        sessionStrategy: "default",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(500);
    expect(sandbox.beginLeaseDestructionAfterExecution).toHaveBeenCalledOnce();
    expect(sandbox.completeLeaseExecution).not.toHaveBeenCalled();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched acquisition before mutating or touching the sandbox filesystem", async () => {
    const { sandbox, sessionExec } = createSandbox({
      ownership: ownership("pc-acq-acquisition-1", "acquisition-owner"),
    });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-other",
        keepAlive: true,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "sandbox_state_lost" });
    expect(sandbox.beginLeaseExecution).not.toHaveBeenCalled();
    expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
    expect(sessionExec).not.toHaveBeenCalled();
  });

  it("rejects resume when the provider lease ID differs despite the same acquisition ID", async () => {
    const { sandbox, sessionExec } = createSandbox({
      ownership: ownership("pc-acq-foreign", "acquisition-1"),
    });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/resume", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        keepAlive: true,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "sandbox_state_lost" });
    expect(sandbox.beginLeaseExecution).not.toHaveBeenCalled();
    expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
    expect(sessionExec).not.toHaveBeenCalled();
  });

  it("requires the matching acquisition identity to destroy authoritative ownership", async () => {
    const { sandbox } = createSandbox({ ownership: ownership() });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const missing = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1", {}, "DELETE"),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    const mismatched = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-other" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(missing.status).toBe(409);
    expect(mismatched.status).toBe(409);
    expect(sandbox.destroy).not.toHaveBeenCalled();
    expect(sandbox.completeLeaseDestruction).not.toHaveBeenCalled();
  });

  it("migrates matching legacy ownership for non-reusable release without an acquisition identity", async () => {
    const sessionExec = vi.fn().mockImplementation(async (command: string) => ({
      exitCode: 0,
      stdout: command.includes("test ! -e")
        ? JSON.stringify({ providerLeaseId: "pc-acq-acquisition-1", remoteCwd: "/workspace/paperclip" })
        : "",
      stderr: "",
    }));
    const { sandbox } = createSandbox({ sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/release", {
        providerLeaseId: "pc-acq-acquisition-1",
        reuseLease: false,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(sandbox.claimLeaseOwnership).toHaveBeenCalledWith({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "legacy:pc-acq-acquisition-1",
      acquisitionFingerprint: "legacy:pc-acq-acquisition-1",
    });
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("migrates matching legacy ownership at its persisted custom workspace for DELETE", async () => {
    const sessionExec = vi.fn().mockImplementation(async (command: string) => ({
      exitCode: 0,
      stdout: command.includes("test ! -e")
        ? JSON.stringify({ providerLeaseId: "pc-acq-acquisition-1", remoteCwd: "/workspace/custom" })
        : "",
      stderr: "",
    }));
    const { sandbox } = createSandbox({ sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { requestedCwd: "/workspace/custom" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(sandbox.claimLeaseOwnership).toHaveBeenCalledWith({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "legacy:pc-acq-acquisition-1",
      acquisitionFingerprint: "legacy:pc-acq-acquisition-1",
    });
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("does not adopt legacy ownership from a caller-selected workspace", async () => {
    const sessionExec = vi.fn().mockImplementation(async (command: string) => ({
      exitCode: 0,
      stdout: command.includes("/tmp/caller-selected-workspace")
        ? JSON.stringify({ providerLeaseId: "pc-acq-acquisition-1", remoteCwd: DEFAULT_REMOTE_CWD })
        : "",
      stderr: "",
    }));
    const { sandbox } = createSandbox({ sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        {
          requestedCwd: "/tmp/caller-selected-workspace",
        },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "acquisition_conflict" });
    expect(sessionExec).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/caller-selected-workspace"),
      expect.anything(),
    );
    expect(sandbox.claimLeaseOwnership).not.toHaveBeenCalled();
    expect(sandbox.destroy).not.toHaveBeenCalled();
    expect(sandbox.completeLeaseDestruction).not.toHaveBeenCalled();
  });

  it("rejects replay while destruction of the same acquisition is in flight", async () => {
    let finishDestroy!: () => void;
    const destroyPending = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    const destroy = vi.fn().mockReturnValue(destroyPending);
    const { sandbox, sessionExec } = createSandbox({ ownership: ownership(), destroy });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const deletion = handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());

    const replay = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/leases/acquire", acquireBody()),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    finishDestroy();
    const deleted = await deletion;

    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: "acquisition_conflict" });
    expect(deleted.status).toBe(200);
    expect(sandbox.setKeepAlive).not.toHaveBeenCalled();
    expect(sessionExec).not.toHaveBeenCalled();
  });

  it("replays duplicate destruction through the in-flight operation", async () => {
    let finishDestroy!: () => void;
    const destroyPending = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    const destroy = vi.fn().mockReturnValue(destroyPending);
    const { sandbox } = createSandbox({ ownership: ownership(), destroy });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const first = handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());

    const duplicate = handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledOnce();

    finishDestroy();
    expect((await first).status).toBe(200);
    expect((await duplicate).status).toBe(200);
  });

  it("replays completed destruction without touching a later owner", async () => {
    const { sandbox, getOwnership } = createSandbox({ ownership: ownership() });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);
    const request = () => handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect((await request()).status).toBe(200);
    await sandbox.claimLeaseOwnership({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "acquisition-2",
      acquisitionFingerprint: "fingerprint-two",
    });

    expect((await request()).status).toBe(200);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(getOwnership()).toMatchObject({
      providerLeaseId: "pc-acq-acquisition-1",
      acquisitionId: "acquisition-2",
      state: "owned",
    });
  });

  it.each([
    ["missing", ""],
    ["corrupt", "{corrupt-json"],
  ] as const)(
    "destroys a matching authoritative lease even when its sentinel is %s",
    async (_sentinelState, sentinelContents) => {
      const sessionExec = vi.fn().mockImplementation(async (command: string) => ({
        exitCode: 0,
        stdout: command.includes("test ! -e") ? sentinelContents : "",
        stderr: "",
      }));
      const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
      vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

      const response = await handleBridgeRequest(
        bridgeRequest(
          "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
          { acquisitionId: "acquisition-1" },
          "DELETE",
        ),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      );

      expect(response.status).toBe(200);
      expect(sessionExec).not.toHaveBeenCalled();
      expect(sandbox.destroy).toHaveBeenCalledOnce();
      expect(sandbox.completeLeaseDestruction).toHaveBeenCalledWith(
        expect.objectContaining({
          providerLeaseId: "pc-acq-acquisition-1",
          acquisitionId: "acquisition-1",
        }),
        expect.any(String),
      );
    },
  );

  it("propagates indeterminate destroy failures without restoring usable ownership", async () => {
    const destroy = vi.fn()
      .mockRejectedValueOnce(new Error("destroy unavailable"))
      .mockResolvedValueOnce(undefined);
    const { sandbox, getOwnership } = createSandbox({ ownership: ownership(), destroy });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await bridgeWorker.fetch(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "internal_error", message: "destroy unavailable" });
    expect(sandbox.completeLeaseDestruction).not.toHaveBeenCalled();
    expect(getOwnership()).toMatchObject({
      state: "destroying",
      destructionId: expect.any(String),
    });

    const retry = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(retry.status).toBe(200);
    expect(sandbox.destroy).toHaveBeenCalledTimes(2);
    expect(sandbox.completeLeaseDestruction).toHaveBeenCalledOnce();
  });

  it("clears ownership only after successful destruction", async () => {
    const { sandbox } = createSandbox({ ownership: ownership() });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(sandbox.beginLeaseDestruction.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.destroy.mock.invocationCallOrder[0]!,
    );
    expect(sandbox.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.completeLeaseDestruction.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects exec requests that omit acquisition ownership before resolving a sandbox", async () => {
    const { sandbox, sessionExec } = createSandbox({ ownership: ownership() });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v2/exec", {
        providerLeaseId: "pc-acq-acquisition-1",
        command: "pwd",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(resolveSandbox).not.toHaveBeenCalled();
    expect(sessionExec).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["foreign", ownership("pc-acq-acquisition-1", "acquisition-other")],
    [
      "destroying",
      {
        ...ownership(),
        state: "destroying",
        destructionId: "destruction-1",
      } as LeaseOwnershipRecord,
    ],
  ])("rejects exec against %s acquisition ownership without running the command", async (_state, leaseOwnership) => {
    const { sandbox, sessionExec } = createSandbox({ ownership: leaseOwnership });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        command: "pwd",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "acquisition_conflict" });
    expect(sessionExec).not.toHaveBeenCalled();
  });

  it("executes a command only after validating acquisition ownership", async () => {
    const sessionExec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "/workspace/paperclip\n", stderr: "" });
    const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        command: "pwd",
        sessionStrategy: "named",
        sessionId: "paperclip",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(sessionExec).toHaveBeenCalledOnce();
    expect(sandbox.beginLeaseExecution.mock.invocationCallOrder[0]).toBeLessThan(
      sessionExec.mock.invocationCallOrder[0]!,
    );
    expect(sessionExec.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.completeLeaseExecution.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "atomically coordinates default-session timeout destruction (stream=%s, concurrent=%s)",
    async (streamOutput, concurrent) => {
      const activeExecutions = concurrent
        ? [{ executionId: "other-execution", expiresAt: new Date(Date.now() + 60_000).toISOString() }]
        : undefined;
      const sessionExec = vi.fn().mockRejectedValue(new Error("command timed out"));
      const { sandbox } = createSandbox({
        ownership: { ...ownership(), activeExecutions },
        sessionExec,
      });
      vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

      const response = await handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v2/exec", {
          providerLeaseId: "pc-acq-acquisition-1",
          acquisitionId: "acquisition-1",
          command: "sleep",
          sessionStrategy: "default",
          streamOutput,
        }),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      );

      expect(response.status).toBe(200);
      if (streamOutput) {
        expect(await response.text()).toContain('"timedOut":true');
      } else {
        expect(await response.json()).toMatchObject({ timedOut: true });
      }
      expect(sandbox.beginLeaseDestructionAfterExecution).toHaveBeenCalledOnce();
      expect(sandbox.completeLeaseExecution).not.toHaveBeenCalled();
      expect(sandbox.beginLeaseDestruction).not.toHaveBeenCalled();
      expect(sandbox.destroy).toHaveBeenCalledTimes(concurrent ? 0 : 1);
    },
  );

  it("destroys after a concurrent execution completes following a default-session timeout", async () => {
    let finishLongRunning!: () => void;
    const longRunning = new Promise<void>((resolve) => {
      finishLongRunning = resolve;
    });
    const sessionExec = vi.fn(async (command: string) => {
      if (command.includes("long-running")) {
        await longRunning;
        return { exitCode: 0, stdout: "done\n", stderr: "" };
      }
      throw new Error("command timed out");
    });
    const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const longRunningResponse = handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v2/exec", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        command: "long-running",
        sessionStrategy: "default",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    await vi.waitFor(() => expect(sessionExec).toHaveBeenCalledOnce());

    const timedOutResponse = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v2/exec", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        command: "times-out",
        sessionStrategy: "default",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(timedOutResponse.status).toBe(200);
    expect(sandbox.destroy).not.toHaveBeenCalled();

    finishLongRunning();
    expect((await longRunningResponse).status).toBe(200);
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("reports command and execution fence cleanup failures for non-streaming exec", async () => {
    const sessionExec = vi.fn().mockRejectedValue(new Error("command unavailable"));
    const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
    sandbox.completeLeaseExecution.mockRejectedValue(new Error("fence cleanup unavailable"));
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await bridgeWorker.fetch(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        command: "pwd",
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toMatchObject({
      error: "internal_error",
      message: expect.stringContaining("command unavailable"),
    });
    expect(payload).toMatchObject({
      message: expect.stringContaining("fence cleanup unavailable"),
    });
    expect(sandbox.completeLeaseExecution).toHaveBeenCalledOnce();
  });

  it.each([false, true])("blocks lease destruction while exec is active (stream=%s)", async (streamOutput) => {
    let finishCommand!: () => void;
    const commandFinished = new Promise<void>((resolve) => { finishCommand = resolve; });
    const sessionExec = vi.fn(async () => {
      await commandFinished;
      return { exitCode: 0, stdout: "done\n", stderr: "" };
    });
    const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const execResponse = handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        command: "sleep",
        streamOutput,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    const pendingBody = streamOutput
      ? (await execResponse).text()
      : execResponse.then((response) => response.text());
    await vi.waitFor(() => expect(sessionExec).toHaveBeenCalledOnce());

    const blockedDestroy = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(blockedDestroy.status).toBe(409);
    expect(sandbox.destroy).not.toHaveBeenCalled();

    finishCommand();
    await pendingBody;
    const retryDestroy = await handleBridgeRequest(
      bridgeRequest(
        "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
        { acquisitionId: "acquisition-1" },
        "DELETE",
      ),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );
    expect(retryDestroy.status).toBe(200);
  });

  it("uses a bounded execution fence and renews it before expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    try {
      let startCommand!: () => void;
      const commandStarted = new Promise<void>((resolve) => { startCommand = resolve; });
      let finishCommand!: () => void;
      const commandFinished = new Promise<void>((resolve) => { finishCommand = resolve; });
      const sessionExec = vi.fn(async () => {
        startCommand();
        await commandFinished;
        return { exitCode: 0, stdout: "done\n", stderr: "" };
      });
      const { sandbox, getOwnership } = createSandbox({ ownership: ownership(), sessionExec });
      vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

      const execResponse = handleBridgeRequest(
        bridgeRequest("/api/paperclip-sandbox/v1/exec", {
          providerLeaseId: "pc-acq-acquisition-1",
          acquisitionId: "acquisition-1",
          command: "sleep",
          timeoutMs: 24 * 60 * 60_000,
        }),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      );
      await commandStarted;
      expect(sessionExec).toHaveBeenCalledOnce();
      const initialOwnership = getOwnership();
      if (!initialOwnership || initialOwnership === "invalid") throw new Error("Expected active lease ownership");
      expect(initialOwnership.activeExecutions).toHaveLength(1);
      const originalExpiry = initialOwnership.activeExecutions?.[0]?.expiresAt;
      expect(originalExpiry).toBe("2026-08-04T00:01:00.000Z");

      await vi.advanceTimersByTimeAsync(65_000);
      const renewedOwnership = getOwnership();
      if (!renewedOwnership || renewedOwnership === "invalid") throw new Error("Expected renewed lease ownership");
      expect(Date.parse(renewedOwnership.activeExecutions?.[0]?.expiresAt ?? "")).toBeGreaterThan(
        Date.parse(originalExpiry ?? ""),
      );
      const blockedDestroy = await handleBridgeRequest(
        bridgeRequest(
          "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
          { acquisitionId: "acquisition-1" },
          "DELETE",
        ),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      );
      expect(blockedDestroy.status).toBe(409);
      expect(sandbox.destroy).not.toHaveBeenCalled();

      finishCommand();
      expect((await execResponse).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a renewal failure and destroys only after the operation settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    try {
      let startCommand!: () => void;
      const commandStarted = new Promise<void>((resolve) => { startCommand = resolve; });
      let finishCommand!: () => void;
      const commandFinished = new Promise<void>((resolve) => { finishCommand = resolve; });
      let commandCompleted = false;
      const sessionExec = vi.fn(async () => {
        startCommand();
        await commandFinished;
        commandCompleted = true;
        return { exitCode: 0, stdout: "done\n", stderr: "" };
      });
      const destroy = vi.fn(async () => {
        expect(commandCompleted).toBe(true);
      });
      const { sandbox, getOwnership } = createSandbox({ ownership: ownership(), sessionExec, destroy });
      sandbox.renewLeaseExecution.mockRejectedValue(new Error("renew unavailable"));
      vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

      let responseSettled = false;
      const responsePromise = bridgeWorker.fetch(
        bridgeRequest("/api/paperclip-sandbox/v1/exec", {
          providerLeaseId: "pc-acq-acquisition-1",
          acquisitionId: "acquisition-1",
          command: "sleep",
          timeoutMs: 24 * 60 * 60_000,
        }),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      ).finally(() => {
        responseSettled = true;
      });
      await commandStarted;
      await vi.advanceTimersByTimeAsync(15_000);

      expect(responseSettled).toBe(false);
      expect(sandbox.quarantineLeaseExecution).toHaveBeenCalledOnce();
      expect(getOwnership()).toMatchObject({
        state: "destroying",
        activeExecutions: [{ executionId: expect.any(String) }],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const blockedDestroy = await handleBridgeRequest(
        bridgeRequest(
          "/api/paperclip-sandbox/v1/leases/pc-acq-acquisition-1",
          { acquisitionId: "acquisition-1" },
          "DELETE",
        ),
        { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
      );
      expect(blockedDestroy.status).toBe(409);
      expect(sandbox.destroy).not.toHaveBeenCalled();
      finishCommand();

      const response = await responsePromise;
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: "internal_error",
        message: "renew unavailable",
      });
      expect(sandbox.destroy).toHaveBeenCalledOnce();
      expect(sandbox.completeLeaseDestruction).toHaveBeenCalledOnce();
      expect(commandCompleted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams exec stdout and completion metadata when requested", async () => {
    const sessionExec = vi.fn().mockImplementation(async (_command, options) => {
      await options?.onOutput?.("stdout", "hello\n");
      return { exitCode: 0, stdout: "hello\n", stderr: "" };
    });
    const { sandbox } = createSandbox({ ownership: ownership(), sessionExec });
    vi.mocked(resolveSandbox).mockResolvedValue(sandbox as never);

    const response = await handleBridgeRequest(
      bridgeRequest("/api/paperclip-sandbox/v1/exec", {
        providerLeaseId: "pc-acq-acquisition-1",
        acquisitionId: "acquisition-1",
        command: "echo",
        args: ["hello"],
        sessionStrategy: "named",
        sessionId: "paperclip",
        streamOutput: true,
      }),
      { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("event: stdout");
    expect(body).toContain("event: complete");
  });
});
