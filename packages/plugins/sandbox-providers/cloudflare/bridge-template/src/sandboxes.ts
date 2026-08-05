import { Sandbox as CloudflareSandbox, getSandbox } from "@cloudflare/sandbox";
import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";

export const LEASE_OWNERSHIP_STORAGE_KEY = "paperclip.leaseOwnership.v1";
const LEASE_DESTRUCTION_STORAGE_PREFIX = "paperclip.leaseDestruction.v1";

export interface LeaseOwnershipRecord {
  version: 1;
  providerLeaseId: string;
  acquisitionId: string;
  acquisitionFingerprint: string;
  state: "owned" | "destroying";
  setupComplete?: boolean;
  destructionId?: string;
  activeExecutions?: Array<{
    executionId: string;
    expiresAt: string;
  }>;
  updatedAt: string;
}

interface LeaseDestructionRecord extends LeaseOwnershipIdentity {
  version: 1;
  completedAt: string;
}

export interface LeaseOwnershipIdentity {
  providerLeaseId: string;
  acquisitionId: string;
}

export interface LeaseOwnershipClaim extends LeaseOwnershipIdentity {
  acquisitionFingerprint: string;
  setupExecutionId?: string;
  setupExpiresAt?: string;
}

export type LeaseOwnershipReadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "owned" | "destroying"; ownership: LeaseOwnershipRecord };

export type LeaseOwnershipClaimResult =
  | { status: "claimed" | "replayed"; ownership: LeaseOwnershipRecord }
  | { status: "in_progress"; ownership: LeaseOwnershipRecord }
  | { status: "destroying"; ownership: LeaseOwnershipRecord }
  | { status: "completed" | "invalid" }
  | { status: "conflict"; ownership: LeaseOwnershipRecord };

export type LeaseOwnershipUpdateResult =
  | { status: "updated"; ownership: LeaseOwnershipRecord }
  | { status: "missing" | "invalid" }
  | { status: "destroying"; ownership: LeaseOwnershipRecord }
  | { status: "conflict"; ownership: LeaseOwnershipRecord };

export type LeaseOwnershipExecutionResult =
  | { status: "started" | "replayed" | "renewed" | "completed" | "destruction_started"; ownership: LeaseOwnershipRecord }
  | { status: "missing" | "invalid" }
  | { status: "destroying" | "conflict"; ownership: LeaseOwnershipRecord };

export type LeaseOwnershipDestroyResult =
  | { status: "started"; ownership: LeaseOwnershipRecord }
  | { status: "in_progress"; ownership: LeaseOwnershipRecord }
  | { status: "completed" }
  | { status: "missing" | "invalid" }
  | { status: "conflict"; ownership: LeaseOwnershipRecord };

export type LeaseOwnershipQuarantineResult =
  | { status: "quarantined" | "in_progress"; ownership: LeaseOwnershipRecord }
  | { status: "missing" | "invalid" }
  | { status: "conflict"; ownership: LeaseOwnershipRecord };

export type LeaseOwnershipCompleteResult =
  | { status: "completed" }
  | { status: "missing" | "invalid" }
  | { status: "conflict"; ownership: LeaseOwnershipRecord };

function isLeaseOwnershipRecord(value: unknown): value is LeaseOwnershipRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LeaseOwnershipRecord>;
  return candidate.version === 1
    && typeof candidate.providerLeaseId === "string"
    && candidate.providerLeaseId.length > 0
    && typeof candidate.acquisitionId === "string"
    && candidate.acquisitionId.length > 0
    && typeof candidate.acquisitionFingerprint === "string"
    && candidate.acquisitionFingerprint.length > 0
    && (candidate.state === "owned" || candidate.state === "destroying")
    && (candidate.setupComplete === undefined || typeof candidate.setupComplete === "boolean")
    && (candidate.state === "owned"
      ? candidate.destructionId === undefined
      : typeof candidate.destructionId === "string" && candidate.destructionId.length > 0)
    && (candidate.activeExecutions === undefined
      || (Array.isArray(candidate.activeExecutions)
        && candidate.activeExecutions.every((execution) => execution
          && typeof execution === "object"
          && typeof execution.executionId === "string"
          && execution.executionId.length > 0
          && typeof execution.expiresAt === "string"
          && Number.isFinite(Date.parse(execution.expiresAt)))))
    && typeof candidate.updatedAt === "string"
    && Number.isFinite(Date.parse(candidate.updatedAt));
}

function isLeaseDestructionRecord(value: unknown): value is LeaseDestructionRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LeaseDestructionRecord>;
  return candidate.version === 1
    && typeof candidate.providerLeaseId === "string"
    && candidate.providerLeaseId.length > 0
    && typeof candidate.acquisitionId === "string"
    && candidate.acquisitionId.length > 0
    && typeof candidate.completedAt === "string"
    && candidate.completedAt.length > 0;
}

function destructionStorageKey(identity: LeaseOwnershipIdentity): string {
  return `${LEASE_DESTRUCTION_STORAGE_PREFIX}:${encodeURIComponent(identity.providerLeaseId)}:${encodeURIComponent(identity.acquisitionId)}`;
}

function ownershipMatches(record: LeaseOwnershipRecord, identity: LeaseOwnershipIdentity): boolean {
  return record.providerLeaseId === identity.providerLeaseId
    && record.acquisitionId === identity.acquisitionId;
}

function newOwnershipRecord(claim: LeaseOwnershipClaim): LeaseOwnershipRecord {
  const setupExecution = claim.setupExecutionId && claim.setupExpiresAt
    ? [{ executionId: claim.setupExecutionId, expiresAt: claim.setupExpiresAt }]
    : undefined;
  return {
    version: 1,
    providerLeaseId: claim.providerLeaseId,
    acquisitionId: claim.acquisitionId,
    acquisitionFingerprint: claim.acquisitionFingerprint,
    state: "owned",
    setupComplete: setupExecution === undefined,
    activeExecutions: setupExecution,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Paperclip extends the SDK Durable Object so ownership lives outside the
 * agent-writable container filesystem. Public methods are forwarded by the
 * SDK's typed RPC proxy returned from getSandbox().
 */
export class Sandbox extends CloudflareSandbox {
  async readContainerState(): Promise<Awaited<ReturnType<CloudflareSandbox["getState"]>>> {
    return await this.getState();
  }

  async readLeaseOwnership(): Promise<LeaseOwnershipReadResult> {
    const stored = await this.ctx.storage.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
    if (stored === undefined) return { status: "missing" };
    if (!isLeaseOwnershipRecord(stored)) return { status: "invalid" };
    return { status: stored.state, ownership: stored };
  }

  async claimLeaseOwnership(claim: LeaseOwnershipClaim): Promise<LeaseOwnershipClaimResult> {
    const setupExpiresAtMs = Date.parse(claim.setupExpiresAt ?? "");
    const hasSetupExecution = Boolean(claim.setupExecutionId)
      && Number.isFinite(setupExpiresAtMs)
      && setupExpiresAtMs > Date.now();
    if (Boolean(claim.setupExecutionId) !== Boolean(claim.setupExpiresAt) || (claim.setupExecutionId && !hasSetupExecution)) {
      return { status: "invalid" };
    }
    return await this.ctx.storage.transaction(async (transaction) => {
      const completed = await transaction.get<unknown>(destructionStorageKey(claim));
      if (completed !== undefined) {
        return isLeaseDestructionRecord(completed)
            && completed.providerLeaseId === claim.providerLeaseId
            && completed.acquisitionId === claim.acquisitionId
          ? { status: "completed" }
          : { status: "invalid" };
      }

      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored !== undefined) {
        if (!isLeaseOwnershipRecord(stored)) return { status: "invalid" };
        if (stored.state === "destroying") return { status: "destroying", ownership: stored };
        if (!ownershipMatches(stored, claim) || stored.acquisitionFingerprint !== claim.acquisitionFingerprint) {
          return { status: "conflict", ownership: stored };
        }
        if (stored.setupComplete !== false) return { status: "replayed", ownership: stored };
        const now = Date.now();
        const executions = stored.activeExecutions ?? [];
        const activeExecutions = executions.filter((execution) => Date.parse(execution.expiresAt) > now);
        if (activeExecutions.length > 0 || !hasSetupExecution) {
          if (activeExecutions.length === executions.length) return { status: "in_progress", ownership: stored };
          const ownership = { ...stored, activeExecutions, updatedAt: new Date(now).toISOString() };
          await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
          return { status: "in_progress", ownership };
        }
        const ownership: LeaseOwnershipRecord = {
          ...stored,
          activeExecutions: [{ executionId: claim.setupExecutionId!, expiresAt: claim.setupExpiresAt! }],
          updatedAt: new Date(now).toISOString(),
        };
        await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
        return { status: "claimed", ownership };
      }

      const ownership = newOwnershipRecord(claim);
      await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
      return { status: "claimed", ownership };
    });
  }

  async updateLeaseOwnership(identity: LeaseOwnershipIdentity): Promise<LeaseOwnershipUpdateResult> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored === undefined) return { status: "missing" };
      if (!isLeaseOwnershipRecord(stored)) return { status: "invalid" };
      if (!ownershipMatches(stored, identity)) return { status: "conflict", ownership: stored };
      if (stored.state === "destroying") return { status: "destroying", ownership: stored };

      const ownership = { ...stored, updatedAt: new Date().toISOString() };
      await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
      return { status: "updated", ownership };
    });
  }

  async beginLeaseExecution(
    identity: LeaseOwnershipIdentity,
    executionId: string,
    expiresAt: string,
  ): Promise<LeaseOwnershipExecutionResult> {
    const expiresAtMs = Date.parse(expiresAt);
    if (!executionId || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return { status: "invalid" };
    }
    return await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored === undefined) return { status: "missing" };
      if (!isLeaseOwnershipRecord(stored)) return { status: "invalid" };
      if (!ownershipMatches(stored, identity)) return { status: "conflict", ownership: stored };
      if (stored.state === "destroying") return { status: "destroying", ownership: stored };

      const activeExecutions = stored.activeExecutions ?? [];
      if (activeExecutions.some((execution) => execution.executionId === executionId)) {
        return { status: "replayed", ownership: stored };
      }
      if (stored.setupComplete === false) {
        return { status: "conflict", ownership: stored };
      }
      const ownership: LeaseOwnershipRecord = {
        ...stored,
        activeExecutions: [...activeExecutions, { executionId, expiresAt }],
        updatedAt: new Date().toISOString(),
      };
      await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
      return { status: "started", ownership };
    });
  }

  async completeLeaseExecution(
    identity: LeaseOwnershipIdentity,
    executionId: string,
    completeSetup = false,
  ): Promise<LeaseOwnershipExecutionResult> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored === undefined) return { status: "missing" };
      if (!isLeaseOwnershipRecord(stored) || !executionId) return { status: "invalid" };
      if (!ownershipMatches(stored, identity)) return { status: "conflict", ownership: stored };
      const executions = stored.activeExecutions ?? [];
      if (!executions.some((execution) => execution.executionId === executionId)) {
        return { status: "missing" };
      }
      const activeExecutions = executions.filter((execution) => execution.executionId !== executionId);
      const ownership = {
        ...stored,
        activeExecutions,
        setupComplete: completeSetup ? true : stored.setupComplete,
        updatedAt: new Date().toISOString(),
      };
      await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
      return stored.state === "destroying" && activeExecutions.length === 0
        ? { status: "destruction_started", ownership }
        : { status: "completed", ownership };
    });
  }

  async beginLeaseDestructionAfterExecution(
    identity: LeaseOwnershipIdentity,
    executionId: string,
    destructionId: string,
  ): Promise<LeaseOwnershipDestroyResult> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const completed = await transaction.get<unknown>(destructionStorageKey(identity));
      if (completed !== undefined) {
        return isLeaseDestructionRecord(completed)
            && completed.providerLeaseId === identity.providerLeaseId
            && completed.acquisitionId === identity.acquisitionId
          ? { status: "completed" }
          : { status: "invalid" };
      }

      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored === undefined) return { status: "missing" };
      if (!isLeaseOwnershipRecord(stored) || !executionId || !destructionId) return { status: "invalid" };
      if (!ownershipMatches(stored, identity)) return { status: "conflict", ownership: stored };
      const executions = stored.activeExecutions ?? [];
      if (!executions.some((execution) => execution.executionId === executionId)) {
        return stored.state === "destroying"
          ? { status: "in_progress", ownership: stored }
          : { status: "missing" };
      }

      const activeExecutions = executions.filter((execution) => execution.executionId !== executionId);
      const ownership: LeaseOwnershipRecord = {
        ...stored,
        state: "destroying",
        destructionId: stored.state === "destroying" ? stored.destructionId : destructionId,
        activeExecutions,
        updatedAt: new Date().toISOString(),
      };
      await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
      return activeExecutions.length > 0
        ? { status: "in_progress", ownership }
        : { status: "started", ownership };
    });
  }

  async renewLeaseExecution(
    identity: LeaseOwnershipIdentity,
    executionId: string,
    expiresAt: string,
  ): Promise<LeaseOwnershipExecutionResult> {
    const expiresAtMs = Date.parse(expiresAt);
    if (!executionId || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return { status: "invalid" };
    }
    return await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored === undefined) return { status: "missing" };
      if (!isLeaseOwnershipRecord(stored)) return { status: "invalid" };
      if (!ownershipMatches(stored, identity)) return { status: "conflict", ownership: stored };
      const executions = stored.activeExecutions ?? [];
      if (!executions.some((execution) => execution.executionId === executionId)) {
        return { status: "missing" };
      }
      const activeExecutions = executions
        .map((execution) => execution.executionId === executionId ? { executionId, expiresAt } : execution);
      const ownership: LeaseOwnershipRecord = {
        ...stored,
        activeExecutions,
        updatedAt: new Date().toISOString(),
      };
      await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
      return { status: "renewed", ownership };
    });
  }

  async quarantineLeaseExecution(
    identity: LeaseOwnershipIdentity,
    executionId: string,
    destructionId: string,
  ): Promise<LeaseOwnershipQuarantineResult> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored === undefined) return { status: "missing" };
      if (!isLeaseOwnershipRecord(stored) || !executionId || !destructionId) return { status: "invalid" };
      if (!ownershipMatches(stored, identity)) return { status: "conflict", ownership: stored };
      if (!(stored.activeExecutions ?? []).some((execution) => execution.executionId === executionId)) {
        return { status: "missing" };
      }
      if (stored.state === "destroying") return { status: "in_progress", ownership: stored };

      const ownership: LeaseOwnershipRecord = {
        ...stored,
        state: "destroying",
        destructionId,
        updatedAt: new Date().toISOString(),
      };
      await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
      return { status: "quarantined", ownership };
    });
  }

  async beginLeaseDestruction(
    identity: LeaseOwnershipIdentity,
    destructionId: string,
  ): Promise<LeaseOwnershipDestroyResult> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const completed = await transaction.get<unknown>(destructionStorageKey(identity));
      if (completed !== undefined) {
        return isLeaseDestructionRecord(completed)
            && completed.providerLeaseId === identity.providerLeaseId
            && completed.acquisitionId === identity.acquisitionId
          ? { status: "completed" }
          : { status: "invalid" };
      }

      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored === undefined) return { status: "missing" };
      if (!isLeaseOwnershipRecord(stored)) return { status: "invalid" };
      if (!ownershipMatches(stored, identity)) return { status: "conflict", ownership: stored };
      if (stored.state === "destroying") return { status: "in_progress", ownership: stored };

      const now = Date.now();
      const executions = stored.activeExecutions ?? [];
      const activeExecutions = executions.filter((execution) => Date.parse(execution.expiresAt) > now);
      if (activeExecutions.length > 0) {
        if (activeExecutions.length === executions.length) {
          return { status: "in_progress", ownership: stored };
        }
        const ownership = { ...stored, activeExecutions, updatedAt: new Date(now).toISOString() };
        await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
        return { status: "in_progress", ownership };
      }

      const ownership: LeaseOwnershipRecord = {
        ...stored,
        activeExecutions,
        state: "destroying",
        destructionId,
        updatedAt: new Date(now).toISOString(),
      };
      await transaction.put(LEASE_OWNERSHIP_STORAGE_KEY, ownership);
      return { status: "started", ownership };
    });
  }

  async completeLeaseDestruction(
    identity: LeaseOwnershipIdentity,
    destructionId: string,
  ): Promise<LeaseOwnershipCompleteResult> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(LEASE_OWNERSHIP_STORAGE_KEY);
      if (stored === undefined) {
        const completed = await transaction.get<unknown>(destructionStorageKey(identity));
        return isLeaseDestructionRecord(completed)
            && completed.providerLeaseId === identity.providerLeaseId
            && completed.acquisitionId === identity.acquisitionId
          ? { status: "completed" }
          : { status: "missing" };
      }
      if (!isLeaseOwnershipRecord(stored)) return { status: "invalid" };
      if (!ownershipMatches(stored, identity)) return { status: "conflict", ownership: stored };
      if (stored.state !== "destroying" || stored.destructionId !== destructionId) {
        return { status: "conflict", ownership: stored };
      }

      const completed: LeaseDestructionRecord = {
        version: 1,
        ...identity,
        completedAt: new Date().toISOString(),
      };
      await transaction.put(destructionStorageKey(identity), completed);
      await transaction.delete(LEASE_OWNERSHIP_STORAGE_KEY);
      return { status: "completed" };
    });
  }

}

export interface BridgeEnv {
  Sandbox: DurableObjectNamespace<Sandbox>;
  BRIDGE_AUTH_TOKEN?: string;
}

export interface BridgeLeaseConfig {
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
}

export const DEFAULT_REMOTE_CWD = "/workspace/paperclip";
export const DEFAULT_SESSION_ID = "paperclip";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const LEASE_SENTINEL_FILE = ".paperclip-lease.json";

export function toJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export function toErrorResponse(status: number, error: string, message: string, details?: unknown): Response {
  return toJsonResponse({ error, message, details }, status);
}

export async function resolveSandbox(
  env: BridgeEnv,
  sandboxId: string,
  config: BridgeLeaseConfig,
): Promise<Sandbox> {
  // Pure handle resolution: the constructor accepts keepAlive/sleepAfter so the
  // sandbox is created with the right defaults on first use, but we no longer
  // call `setKeepAlive` here. That side effect now lives in
  // `applySandboxKeepAlive` and is invoked only from lease-management routes,
  // so exec calls don't accidentally overwrite the lease's keepAlive policy.
  return getSandbox<Sandbox>(env.Sandbox, sandboxId, {
    keepAlive: config.keepAlive,
    sleepAfter: config.sleepAfter,
  });
}

export async function applySandboxKeepAlive(
  sandbox: Sandbox,
  keepAlive: boolean,
): Promise<void> {
  await sandbox.setKeepAlive(keepAlive);
}

export { buildLeaseSandboxId, buildSentinelPath, isTimeoutError };
