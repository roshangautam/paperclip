import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  getSandbox: vi.fn(),
}));

import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";
import {
  LEASE_DESTRUCTION_STORAGE_KEY,
  LEASE_OWNERSHIP_STORAGE_KEY,
  Sandbox,
  type LeaseOwnershipRecord,
} from "./sandboxes.js";

function ownership(providerLeaseId = "pc-acq-one", acquisitionId = "acquisition-one"): LeaseOwnershipRecord {
  return {
    version: 1,
    providerLeaseId,
    acquisitionId,
    acquisitionFingerprint: "fingerprint-one",
    state: "owned",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

function createOwnershipSandbox(
  initial?: unknown,
  destroy = vi.fn().mockResolvedValue(undefined),
  legacyDestruction?: unknown,
) {
  const records = new Map<string, unknown>();
  if (initial !== undefined) records.set(LEASE_OWNERSHIP_STORAGE_KEY, initial);
  if (legacyDestruction !== undefined) records.set(LEASE_DESTRUCTION_STORAGE_KEY, legacyDestruction);
  const transaction = {
    get: vi.fn(async (key: string) => records.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      records.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      records.delete(key);
    }),
  };
  const storage = {
    get: vi.fn(async (key: string) => records.get(key)),
    transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => await callback(transaction)),
  };
  const sandbox = Object.create(Sandbox.prototype) as Sandbox;
  Object.defineProperty(sandbox, "ctx", { value: { storage } });
  Object.defineProperty(sandbox, "destroy", { value: destroy });
  Object.defineProperty(sandbox, "liveLeaseExecutions", { value: new Set<string>() });
  return { sandbox, storage, transaction, records, destroy };
}

describe("bridge sandbox helpers", () => {
  it("keeps reusable lease IDs stable across host acquisitions", () => {
    expect(buildLeaseSandboxId({
      acquisitionId: "Acquisition_123",
      environmentId: "Env_123",
      runId: "run-ignored",
      reuseLease: true,
      normalizeId: true,
    })).toBe("pc-env-env-123");
  });

  it("uses a fixed-length workspace scope for reusable lease IDs", () => {
    expect(buildLeaseSandboxId({
      acquisitionId: "Acquisition_123",
      environmentId: "Env_123",
      reuseScopeId: "0123456789abcdef0123456789abcdef",
      runId: "run-ignored",
      reuseLease: true,
      normalizeId: true,
    })).toBe("pc-scope-0123456789abcdef0123456789abcdef");
  });

  it("builds ephemeral lease IDs from acquisition IDs", () => {
    expect(buildLeaseSandboxId({
      acquisitionId: "Acquisition_123",
      environmentId: "env-1",
      runId: "Run_123",
      reuseLease: false,
      normalizeId: true,
    })).toBe("pc-acq-acquisition-123");
  });

  it("builds the workspace sentinel path", () => {
    expect(buildSentinelPath("/workspace/paperclip/")).toBe("/workspace/paperclip/.paperclip-lease.json");
  });

  it("detects timeout-shaped errors", () => {
    expect(isTimeoutError(new Error("command timed out after 10s"))).toBe(true);
    expect(isTimeoutError(new Error("some other error"))).toBe(false);
  });
});

describe("durable lease ownership", () => {
  it("distinguishes missing, invalid, and owned records", async () => {
    const missing = createOwnershipSandbox();
    expect(await missing.sandbox.readLeaseOwnership()).toEqual({ status: "missing" });

    const invalid = createOwnershipSandbox({ providerLeaseId: "pc-acq-one" });
    expect(await invalid.sandbox.readLeaseOwnership()).toEqual({ status: "invalid" });

    const invalidTimestamp = createOwnershipSandbox({ ...ownership(), updatedAt: "not-a-date" });
    expect(await invalidTimestamp.sandbox.readLeaseOwnership()).toEqual({ status: "invalid" });

    const record = ownership();
    const owned = createOwnershipSandbox(record);
    expect(await owned.sandbox.readLeaseOwnership()).toEqual({ status: "owned", ownership: record });
    expect(owned.storage.get).toHaveBeenCalledWith(LEASE_OWNERSHIP_STORAGE_KEY);
  });

  it("transactionally claims once, replays the same identity, and rejects a conflict", async () => {
    const { sandbox, storage, transaction } = createOwnershipSandbox();
    const claim = {
      providerLeaseId: "pc-acq-one",
      acquisitionId: "acquisition-one",
      acquisitionFingerprint: "fingerprint-one",
    };

    const claimed = await sandbox.claimLeaseOwnership(claim);
    expect(claimed).toMatchObject({ status: "claimed", ownership: { ...claim, state: "owned" } });
    expect(await sandbox.claimLeaseOwnership(claim)).toEqual({
      status: "replayed",
      ownership: claimed.status === "claimed" ? claimed.ownership : undefined,
    });
    expect(await sandbox.claimLeaseOwnership({ ...claim, acquisitionId: "acquisition-other" })).toMatchObject({
      status: "conflict",
      ownership: claim,
    });
    expect(await sandbox.claimLeaseOwnership({ ...claim, providerLeaseId: "pc-acq-other" })).toMatchObject({
      status: "conflict",
      ownership: claim,
    });
    expect(await sandbox.claimLeaseOwnership({ ...claim, acquisitionFingerprint: "changed" })).toMatchObject({
      status: "conflict",
      ownership: claim,
    });

    expect(storage.transaction).toHaveBeenCalledTimes(5);
    expect(transaction.put).toHaveBeenCalledOnce();
    expect(transaction.put).toHaveBeenCalledWith(LEASE_OWNERSHIP_STORAGE_KEY, expect.objectContaining(claim));
  });

  it("serializes acquisition setup and replays only after setup completes", async () => {
    const { sandbox } = createOwnershipSandbox();
    const claim = {
      providerLeaseId: "pc-acq-one",
      acquisitionId: "acquisition-one",
      acquisitionFingerprint: "fingerprint-one",
      setupExecutionId: "setup-one",
      setupExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    expect(await sandbox.claimLeaseOwnership(claim)).toMatchObject({
      status: "claimed",
      ownership: {
        setupComplete: false,
        activeExecutions: [{ executionId: "setup-one", expiresAt: claim.setupExpiresAt }],
      },
    });
    expect(await sandbox.claimLeaseOwnership({ ...claim, setupExecutionId: "setup-two" })).toMatchObject({
      status: "in_progress",
      ownership: { activeExecutions: [{ executionId: "setup-one" }] },
    });
    expect(await sandbox.beginLeaseExecution(claim, "execution-one", claim.setupExpiresAt)).toMatchObject({
      status: "conflict",
    });
    expect(await sandbox.completeLeaseExecution(claim, "setup-one", true)).toMatchObject({
      status: "completed",
      ownership: { setupComplete: true, activeExecutions: [] },
    });
    expect(await sandbox.completeLeaseExecution(claim, "setup-one", true)).toEqual({ status: "missing" });
    expect(await sandbox.claimLeaseOwnership({ ...claim, setupExecutionId: "setup-three" })).toMatchObject({
      status: "replayed",
      ownership: { setupComplete: true, activeExecutions: [] },
    });
  });

  it("replaces an expired acquisition setup fence", async () => {
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      setupComplete: false,
      activeExecutions: [{ executionId: "setup-one", expiresAt: new Date(Date.now() - 1).toISOString() }],
    };
    const { sandbox } = createOwnershipSandbox(record);
    const setupExpiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(await sandbox.claimLeaseOwnership({
      ...record,
      setupExecutionId: "setup-two",
      setupExpiresAt,
    })).toMatchObject({
      status: "claimed",
      ownership: { activeExecutions: [{ executionId: "setup-two", expiresAt: setupExpiresAt }] },
    });
  });

  it("keeps a live acquisition setup fence after durable expiry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
      const { sandbox } = createOwnershipSandbox();
      const claim = {
        providerLeaseId: "pc-acq-one",
        acquisitionId: "acquisition-one",
        acquisitionFingerprint: "fingerprint-one",
      };
      const setupExpiresAt = new Date(Date.now() + 1_000).toISOString();

      expect(await sandbox.claimLeaseOwnership({
        ...claim,
        setupExecutionId: "setup-one",
        setupExpiresAt,
      })).toMatchObject({ status: "claimed" });
      vi.advanceTimersByTime(1_000);

      expect(await sandbox.claimLeaseOwnership({
        ...claim,
        setupExecutionId: "setup-two",
        setupExpiresAt: new Date(Date.now() + 1_000).toISOString(),
      })).toMatchObject({
        status: "in_progress",
        ownership: { activeExecutions: [{ executionId: "setup-one", expiresAt: setupExpiresAt }] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences destruction while an execution is active and releases it afterward", async () => {
    const record = ownership();
    const { sandbox } = createOwnershipSandbox(record);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(await sandbox.beginLeaseExecution(identity, "execution-one", expiresAt)).toMatchObject({
      status: "started",
      ownership: { activeExecutions: [{ executionId: "execution-one", expiresAt }] },
    });
    expect(await sandbox.beginLeaseDestruction(identity, "destruction-one")).toMatchObject({
      status: "in_progress",
      ownership: { state: "owned" },
    });
    expect(await sandbox.completeLeaseExecution(identity, "execution-one")).toMatchObject({
      status: "completed",
      ownership: { activeExecutions: [] },
    });
    expect(await sandbox.beginLeaseDestruction(identity, "destruction-two")).toMatchObject({
      status: "started",
      ownership: { state: "destroying", destructionId: "destruction-two" },
    });
  });

  it("fences destruction while the same instance is still executing after durable expiry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
      const record = ownership();
      const { sandbox } = createOwnershipSandbox(record);
      const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

      await sandbox.beginLeaseExecution(identity, "execution-one", new Date(Date.now() + 1_000).toISOString());
      vi.advanceTimersByTime(1_000);

      expect(await sandbox.beginLeaseDestruction(identity, "destruction-one")).toMatchObject({
        status: "in_progress",
        ownership: { state: "owned" },
      });
      await sandbox.completeLeaseExecution(identity, "execution-one");
      expect(await sandbox.beginLeaseDestruction(identity, "destruction-two")).toMatchObject({
        status: "started",
        ownership: { state: "destroying", destructionId: "destruction-two" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes expired execution fences when a new execution starts", async () => {
    const activeExecution = {
      executionId: "execution-active",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      activeExecutions: [
        { executionId: "execution-expired", expiresAt: new Date(Date.now() - 1).toISOString() },
        activeExecution,
      ],
    };
    const { sandbox } = createOwnershipSandbox(record);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };
    const expiresAt = new Date(Date.now() + 120_000).toISOString();

    expect(await sandbox.beginLeaseExecution(identity, "execution-new", expiresAt)).toMatchObject({
      status: "started",
      ownership: { activeExecutions: [activeExecution, { executionId: "execution-new", expiresAt }] },
    });
  });

  it("keeps a live execution fenced when a newer execution destroys its lease", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
      const record = ownership();
      const { sandbox, destroy } = createOwnershipSandbox(record);
      const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };
      const firstExpiresAt = new Date(Date.now() + 1_000).toISOString();

      expect(await sandbox.beginLeaseExecution(identity, "execution-one", firstExpiresAt)).toMatchObject({
        status: "started",
      });
      vi.advanceTimersByTime(1_000);

      expect(await sandbox.beginLeaseExecution(
        identity,
        "execution-two",
        new Date(Date.now() + 1_000).toISOString(),
      )).toMatchObject({ status: "started" });
      expect(await sandbox.destroyLease(identity, "destruction-two", "execution-two")).toMatchObject({
        status: "in_progress",
        ownership: {
          activeExecutions: [{ executionId: "execution-one", expiresAt: firstExpiresAt }],
        },
      });
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("atomically completes an execution fence and begins lease destruction", async () => {
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      activeExecutions: [{ executionId: "execution-one", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    };
    const { sandbox, records } = createOwnershipSandbox(record);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    expect(
      await sandbox.beginLeaseDestructionAfterExecution(identity, "execution-one", "destruction-one"),
    ).toMatchObject({
      status: "started",
      ownership: {
        state: "destroying",
        destructionId: "destruction-one",
        activeExecutions: [],
      },
    });
    expect(records.get(LEASE_OWNERSHIP_STORAGE_KEY)).toMatchObject({
      state: "destroying",
      destructionId: "destruction-one",
      activeExecutions: [],
    });
  });

  it("resumes quarantined destruction after its execution fence expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
      const execution = { executionId: "execution-one", expiresAt: new Date(Date.now() + 1_000).toISOString() };
      const record: LeaseOwnershipRecord = { ...ownership(), activeExecutions: [execution] };
      const { sandbox, records, destroy } = createOwnershipSandbox(record);
      const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

      expect(await sandbox.quarantineLeaseExecution(
        identity,
        execution.executionId,
        "destruction-one",
      )).toMatchObject({
        status: "quarantined",
        ownership: {
          state: "destroying",
          destructionId: "destruction-one",
          activeExecutions: [execution],
        },
      });

      vi.advanceTimersByTime(1_000);

      expect(await sandbox.destroyLease(identity, "destruction-two")).toEqual({ status: "destroyed" });
      expect(destroy).toHaveBeenCalledOnce();
      expect(records.has(LEASE_OWNERSHIP_STORAGE_KEY)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers destruction until the final live execution completes", async () => {
    const otherExecution = {
      executionId: "execution-two",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      activeExecutions: [
        { executionId: "execution-one", expiresAt: new Date(Date.now() + 60_000).toISOString() },
        otherExecution,
      ],
    };
    const { sandbox, records } = createOwnershipSandbox(record);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    expect(
      await sandbox.beginLeaseDestructionAfterExecution(identity, "execution-one", "destruction-one"),
    ).toMatchObject({
      status: "in_progress",
      ownership: {
        state: "destroying",
        destructionId: "destruction-one",
        activeExecutions: [otherExecution],
      },
    });
    expect(records.get(LEASE_OWNERSHIP_STORAGE_KEY)).toMatchObject({
      state: "destroying",
      destructionId: "destruction-one",
      activeExecutions: [otherExecution],
    });
    expect(await sandbox.beginLeaseDestruction(identity, "destruction-two")).toMatchObject({
      status: "in_progress",
      ownership: {
        state: "destroying",
        destructionId: "destruction-one",
        activeExecutions: [otherExecution],
      },
    });
    expect(records.get(LEASE_OWNERSHIP_STORAGE_KEY)).toMatchObject({
      state: "destroying",
      destructionId: "destruction-one",
      activeExecutions: [otherExecution],
    });
    expect(await sandbox.completeLeaseExecution(identity, "execution-two")).toMatchObject({
      status: "destruction_started",
      ownership: { state: "destroying", destructionId: "destruction-one", activeExecutions: [] },
    });
  });

  it("does not mutate ownership for a foreign execution-to-destruction request", async () => {
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      activeExecutions: [{ executionId: "execution-one", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    };
    const { sandbox, records, transaction } = createOwnershipSandbox(record);

    expect(await sandbox.beginLeaseDestructionAfterExecution(
      { providerLeaseId: record.providerLeaseId, acquisitionId: "acquisition-other" },
      "execution-one",
      "destruction-one",
    )).toEqual({ status: "conflict", ownership: record });
    expect(records.get(LEASE_OWNERSHIP_STORAGE_KEY)).toBe(record);
    expect(transaction.put).not.toHaveBeenCalled();
  });

  it("does not begin destruction when the execution fence is missing", async () => {
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      activeExecutions: [{ executionId: "execution-one", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
    };
    const { sandbox, records, transaction } = createOwnershipSandbox(record);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    expect(
      await sandbox.beginLeaseDestructionAfterExecution(identity, "execution-missing", "destruction-one"),
    ).toEqual({ status: "missing" });
    expect(records.get(LEASE_OWNERSHIP_STORAGE_KEY)).toBe(record);
    expect(transaction.put).not.toHaveBeenCalled();
  });

  it("renews an execution fence transactionally", async () => {
    const record = ownership();
    const { sandbox } = createOwnershipSandbox(record);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };
    const originalExpiry = new Date(Date.now() + 60_000).toISOString();
    const renewedExpiry = new Date(Date.now() + 120_000).toISOString();

    await sandbox.beginLeaseExecution(identity, "execution-one", originalExpiry);
    expect(await sandbox.renewLeaseExecution(identity, "execution-one", renewedExpiry)).toMatchObject({
      status: "renewed",
      ownership: { activeExecutions: [{ executionId: "execution-one", expiresAt: renewedExpiry }] },
    });
    expect(await sandbox.beginLeaseDestruction(identity, "destruction-one")).toMatchObject({
      status: "in_progress",
      ownership: { state: "owned" },
    });
  });

  it("prunes an expired execution fence before destruction", async () => {
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      activeExecutions: [{ executionId: "expired", expiresAt: new Date(Date.now() - 1).toISOString() }],
    };
    const { sandbox } = createOwnershipSandbox(record);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    expect(await sandbox.beginLeaseDestruction(identity, "destruction-one")).toMatchObject({
      status: "started",
      ownership: { activeExecutions: [], state: "destroying", destructionId: "destruction-one" },
    });
  });

  it("pins destruction retries to one id and records completion before clearing ownership", async () => {
    const record = ownership();
    const { sandbox, transaction } = createOwnershipSandbox(record);
    const matching = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };
    const foreign = { ...matching, acquisitionId: "acquisition-other" };

    expect(await sandbox.updateLeaseOwnership(foreign)).toEqual({ status: "conflict", ownership: record });
    expect(transaction.put).not.toHaveBeenCalled();

    const updated = await sandbox.updateLeaseOwnership(matching);
    expect(updated).toMatchObject({ status: "updated", ownership: matching });
    expect(transaction.put).toHaveBeenCalledOnce();

    expect(await sandbox.beginLeaseDestruction(foreign, "destruction-foreign")).toMatchObject({
      status: "conflict",
      ownership: matching,
    });
    const started = await sandbox.beginLeaseDestruction(matching, "destruction-one");
    expect(started).toMatchObject({
      status: "started",
      ownership: { ...matching, state: "destroying", destructionId: "destruction-one" },
    });
    expect(await sandbox.beginLeaseDestruction(matching, "destruction-two")).toMatchObject({
      status: "in_progress",
      ownership: { destructionId: "destruction-one" },
    });
    expect(await sandbox.updateLeaseOwnership(matching)).toMatchObject({ status: "destroying" });
    expect(await sandbox.claimLeaseOwnership({ ...record })).toMatchObject({ status: "destroying" });

    expect(await sandbox.completeLeaseDestruction(foreign, "destruction-one")).toMatchObject({
      status: "conflict",
      ownership: matching,
    });
    expect(await sandbox.completeLeaseDestruction(matching, "destruction-two")).toMatchObject({
      status: "conflict",
      ownership: matching,
    });
    expect(await sandbox.completeLeaseDestruction(matching, "destruction-one")).toEqual({ status: "completed" });
    expect(transaction.delete).toHaveBeenCalledWith(LEASE_OWNERSHIP_STORAGE_KEY);
    expect(await sandbox.readLeaseOwnership()).toEqual({ status: "missing" });
    expect(await sandbox.claimLeaseOwnership(record)).toEqual({ status: "completed" });
    expect(await sandbox.readLeaseOwnership()).toEqual({ status: "missing" });
  });

  it("keeps acquisition A terminal after acquisition B destroys the same reusable sandbox", async () => {
    const record = ownership();
    const { sandbox, records } = createOwnershipSandbox(record);
    const matching = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    expect(await sandbox.beginLeaseDestruction(matching, "destruction-one")).toMatchObject({ status: "started" });
    expect(await sandbox.completeLeaseDestruction(matching, "destruction-one")).toEqual({ status: "completed" });

    const laterClaim = {
      providerLeaseId: record.providerLeaseId,
      acquisitionId: "acquisition-two",
      acquisitionFingerprint: "fingerprint-two",
    };
    expect(await sandbox.claimLeaseOwnership(laterClaim)).toMatchObject({ status: "claimed" });
    expect(await sandbox.beginLeaseDestruction(matching, "destruction-retry")).toEqual({ status: "completed" });
    expect(await sandbox.readLeaseOwnership()).toMatchObject({
      status: "owned",
      ownership: laterClaim,
    });

    expect(await sandbox.beginLeaseDestruction(laterClaim, "destruction-two")).toMatchObject({ status: "started" });
    expect(await sandbox.completeLeaseDestruction(laterClaim, "destruction-two")).toEqual({ status: "completed" });
    expect(records.size).toBe(1);
    expect(records.get(LEASE_DESTRUCTION_STORAGE_KEY)).toEqual({
      version: 2,
      entries: [
        expect.objectContaining({ acquisitionId: "acquisition-two" }),
        expect.objectContaining({ acquisitionId: "acquisition-one" }),
      ],
    });
    expect(await sandbox.claimLeaseOwnership(record)).toEqual({ status: "completed" });
    expect(await sandbox.beginLeaseDestruction(laterClaim, "destruction-retry")).toEqual({ status: "completed" });
    expect(await sandbox.readLeaseOwnership()).toEqual({ status: "missing" });
  });

  it("retains bounded destruction history through the maximum replay window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-05T00:00:00.000Z");
    const { sandbox, records } = createOwnershipSandbox();
    try {
      for (let index = 0; index < 32; index += 1) {
        const claim = {
          providerLeaseId: "pc-env-shared",
          acquisitionId: `acquisition-${index}`,
          acquisitionFingerprint: `fingerprint-${index}`,
        };
        expect(await sandbox.claimLeaseOwnership(claim)).toMatchObject({ status: "claimed" });
        expect(await sandbox.beginLeaseDestruction(claim, `destruction-${index}`)).toMatchObject({ status: "started" });
        expect(await sandbox.completeLeaseDestruction(claim, `destruction-${index}`)).toEqual({ status: "completed" });
      }

      const delayedReplay = {
        providerLeaseId: "pc-env-shared",
        acquisitionId: "acquisition-0",
        acquisitionFingerprint: "fingerprint-0",
      };
      expect(await sandbox.claimLeaseOwnership(delayedReplay)).toEqual({ status: "completed" });

      const laterClaim = {
        providerLeaseId: "pc-env-shared",
        acquisitionId: "acquisition-32",
        acquisitionFingerprint: "fingerprint-32",
      };
      expect(await sandbox.claimLeaseOwnership(laterClaim)).toEqual({ status: "invalid" });

      vi.advanceTimersByTime(25 * 60 * 60_000);
      expect(await sandbox.claimLeaseOwnership(laterClaim)).toMatchObject({ status: "claimed" });
      expect(await sandbox.beginLeaseDestruction(laterClaim, "destruction-32")).toMatchObject({ status: "started" });
      expect(await sandbox.completeLeaseDestruction(laterClaim, "destruction-32")).toEqual({ status: "completed" });
      expect(records.get(LEASE_DESTRUCTION_STORAGE_KEY)).toEqual({
        version: 2,
        entries: [expect.objectContaining({ acquisitionId: "acquisition-32" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps legacy singleton destruction tombstones replay-compatible", async () => {
    const record = ownership();
    const legacyDestruction = {
      version: 1,
      providerLeaseId: record.providerLeaseId,
      acquisitionId: record.acquisitionId,
      completedAt: "2026-08-04T00:01:00.000Z",
    };
    const { sandbox, records } = createOwnershipSandbox(undefined, undefined, legacyDestruction);

    expect(await sandbox.claimLeaseOwnership(record)).toEqual({ status: "completed" });
    expect(await sandbox.beginLeaseDestruction(record, "destruction-retry")).toEqual({ status: "completed" });
    expect(await sandbox.completeLeaseDestruction(record, "destruction-retry")).toEqual({ status: "completed" });
    expect(records.get(LEASE_DESTRUCTION_STORAGE_KEY)).toEqual(legacyDestruction);
    expect(await sandbox.readLeaseOwnership()).toEqual({ status: "missing" });
  });

  it("keeps legacy per-acquisition destruction tombstones replay-compatible", async () => {
    const record = ownership();
    const { sandbox, records } = createOwnershipSandbox();
    records.set(
      `${LEASE_DESTRUCTION_STORAGE_KEY}:${JSON.stringify([record.providerLeaseId, record.acquisitionId])}`,
      {
        version: 1,
        providerLeaseId: record.providerLeaseId,
        acquisitionId: record.acquisitionId,
        completedAt: "2026-08-04T00:01:00.000Z",
      },
    );

    expect(await sandbox.claimLeaseOwnership(record)).toEqual({ status: "completed" });
    expect(await sandbox.beginLeaseDestruction(record, "destruction-retry")).toEqual({ status: "completed" });
    expect(await sandbox.readLeaseOwnership()).toEqual({ status: "missing" });
  });

  it("keeps old destruction quarantined regardless of age", async () => {
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      state: "destroying",
      destructionId: "destruction-abandoned",
      updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    };
    const { sandbox, transaction } = createOwnershipSandbox(record);
    const matching = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    expect(await sandbox.beginLeaseDestruction(matching, "destruction-retry")).toEqual({
      status: "in_progress",
      ownership: record,
    });
    expect(transaction.put).not.toHaveBeenCalled();
  });

  it("retries failed destruction with the persisted operation id", async () => {
    const record = ownership();
    const destroy = vi.fn()
      .mockRejectedValueOnce(new Error("destroy unavailable"))
      .mockResolvedValueOnce(undefined);
    const { sandbox, records } = createOwnershipSandbox(record, destroy);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    await expect(sandbox.destroyLease(identity, "destruction-one")).rejects.toThrow("destroy unavailable");
    expect(records.get(LEASE_OWNERSHIP_STORAGE_KEY)).toMatchObject({
      state: "destroying",
      destructionId: "destruction-one",
    });

    expect(await sandbox.destroyLease(identity, "destruction-two")).toEqual({ status: "destroyed" });
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(records.has(LEASE_OWNERSHIP_STORAGE_KEY)).toBe(false);
  });

  it("shares one in-flight destruction across duplicate retries", async () => {
    const record = ownership();
    let finishDestroy!: () => void;
    const destroy = vi.fn().mockReturnValue(new Promise<void>((resolve) => { finishDestroy = resolve; }));
    const { sandbox } = createOwnershipSandbox(record, destroy);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    const first = sandbox.destroyLease(identity, "destruction-one");
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
    const duplicate = sandbox.destroyLease(identity, "destruction-two");
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledOnce();

    finishDestroy();
    await expect(first).resolves.toEqual({ status: "destroyed" });
    await expect(duplicate).resolves.toEqual({ status: "destroyed" });
  });

  it("does not coalesce release or distinct execution cleanups", async () => {
    const record: LeaseOwnershipRecord = {
      ...ownership(),
      activeExecutions: ["release", "execution-two"].map((executionId) => ({
        executionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    };
    const { sandbox, records, destroy } = createOwnershipSandbox(record);
    const identity = { providerLeaseId: record.providerLeaseId, acquisitionId: record.acquisitionId };

    const release = sandbox.destroyLease(identity, "destruction-release");
    const firstExecutionCleanup = sandbox.destroyLease(identity, "destruction-one", "release");
    const secondExecutionCleanup = sandbox.destroyLease(identity, "destruction-two", "execution-two");

    await expect(release).resolves.toMatchObject({ status: "in_progress" });
    await expect(firstExecutionCleanup).resolves.toMatchObject({ status: "in_progress" });
    await expect(secondExecutionCleanup).resolves.toEqual({ status: "destroyed" });
    expect(destroy).toHaveBeenCalledOnce();
    expect(records.has(LEASE_OWNERSHIP_STORAGE_KEY)).toBe(false);
  });
});
