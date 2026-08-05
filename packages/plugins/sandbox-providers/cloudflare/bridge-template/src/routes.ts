import { isAuthorizedRequest } from "./auth.js";
import { executeInSandbox } from "./exec.js";
import { shellQuote } from "./helpers.js";
import {
  buildLeaseSandboxId,
  buildSentinelPath,
  DEFAULT_REMOTE_CWD,
  DEFAULT_SESSION_ID,
  DEFAULT_TIMEOUT_MS,
  resolveSandbox,
  applySandboxKeepAlive,
  toErrorResponse,
  toJsonResponse,
  type BridgeEnv,
  type LeaseOwnershipIdentity,
  type LeaseOwnershipRecord,
  type Sandbox,
} from "./sandboxes.js";
import type { SessionStrategy } from "./sessions.js";

interface ProbeRequestBody {
  requestedCwd?: string;
  keepAlive?: boolean;
  sleepAfter?: string;
  normalizeId?: boolean;
  sessionStrategy?: SessionStrategy;
  sessionId?: string;
  timeoutMs?: number;
}

interface AcquireLeaseRequestBody extends ProbeRequestBody {
  acquisitionId?: string;
  environmentId?: string;
  reuseScopeId?: string;
  runId?: string;
  issueId?: string | null;
  reuseLease?: boolean;
}

interface ResumeLeaseRequestBody extends ProbeRequestBody {
  providerLeaseId?: string;
  acquisitionId?: string;
}

interface ReleaseLeaseRequestBody extends ProbeRequestBody {
  providerLeaseId?: string;
  acquisitionId?: string;
  reuseLease?: boolean;
}

interface DestroyLeaseRequestBody extends ProbeRequestBody {
  providerLeaseId?: string;
  acquisitionId?: string;
}

interface ExecuteRequestBody {
  providerLeaseId?: string;
  acquisitionId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  streamOutput?: boolean;
  sessionStrategy?: SessionStrategy;
  sessionId?: string;
}

const EXECUTION_FENCE_RENEW_INTERVAL_MS = 15_000;
const EXECUTION_FENCE_TTL_MS = EXECUTION_FENCE_RENEW_INTERVAL_MS * 4;

function readBoolean(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : value === true;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function readSessionStrategy(value: unknown): SessionStrategy {
  return value === "default" ? "default" : "named";
}

function buildAcquisitionFingerprint(input: {
  environmentId: string;
  runId: string;
  issueId: string | null;
  remoteCwd: string;
  sessionStrategy: SessionStrategy;
  sessionId: string;
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
  reuseLease: boolean;
  reuseScopeId: string | null;
}): string {
  return JSON.stringify(input);
}

async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function encodeSseEvent(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function toSseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

async function execLeaseUtility(
  sandbox: Sandbox,
  options: {
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
  command: string,
  args: string[],
  cwd = "/",
) {
  return await executeInSandbox({
    sandbox,
    command,
    args,
    cwd,
    timeoutMs: options.timeoutMs,
    sessionStrategy: options.sessionStrategy,
    sessionId: options.sessionId,
  });
}

function requireZeroExit(action: string, result: { exitCode: number | null; timedOut: boolean; stderr: string }) {
  if (result.timedOut) {
    throw new Error(`${action} timed out: ${result.stderr.trim()}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `${action} failed with exit code ${result.exitCode ?? "null"}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
}

async function ensureWorkspace(
  sandbox: Sandbox,
  options: {
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
) {
  const result = await execLeaseUtility(sandbox, options, "mkdir", ["-p", options.remoteCwd], "/");
  requireZeroExit(`ensure workspace ${options.remoteCwd}`, result);
}

async function writeSentinelMirror(
  sandbox: Sandbox,
  input: {
    providerLeaseId: string;
    acquisitionId: string;
    acquisitionFingerprint: string;
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    keepAlive: boolean;
    sleepAfter: string;
    normalizeId: boolean;
    resumedLease: boolean;
    timeoutMs: number;
  },
): Promise<void> {
  const sentinelPayload = JSON.stringify({
    provider: "cloudflare",
    providerLeaseId: input.providerLeaseId,
    acquisitionId: input.acquisitionId,
    acquisitionFingerprint: input.acquisitionFingerprint,
    remoteCwd: input.remoteCwd,
    sessionStrategy: input.sessionStrategy,
    sessionId: input.sessionId,
    keepAlive: input.keepAlive,
    sleepAfter: input.sleepAfter,
    normalizeId: input.normalizeId,
    resumedLease: input.resumedLease,
    updatedAt: new Date().toISOString(),
  }, null, 2);
  const sentinelPath = buildSentinelPath(input.remoteCwd);
  const pendingPath = `${sentinelPath}.pending.${crypto.randomUUID()}`;
  const script = [
    "set -eu",
    `mkdir -p ${shellQuote(input.remoteCwd)}`,
    `pending_path=${shellQuote(pendingPath)}`,
    `trap 'rm -f -- "$pending_path"' EXIT`,
    `printf '%s\\n' ${shellQuote(sentinelPayload)} > "$pending_path"`,
    `mv -- "$pending_path" ${shellQuote(sentinelPath)}`,
  ].join("\n");
  const result = await execLeaseUtility(
    sandbox,
    input,
    "sh",
    ["-c", script],
    "/",
  );
  requireZeroExit(`write ownership mirror ${sentinelPath}`, result);
}

type SentinelOwnership =
  | { status: "missing" | "invalid" }
  | {
      status: "owned";
      acquisitionId: string | null;
      acquisitionFingerprint: string;
      legacy: boolean;
    };

async function readSentinelOwnership(
  sandbox: Sandbox,
  input: {
    providerLeaseId: string;
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
): Promise<SentinelOwnership> {
  const sentinelPath = buildSentinelPath(input.remoteCwd);
  const result = await execLeaseUtility(
    sandbox,
    input,
    "sh",
    ["-c", `test ! -e ${shellQuote(sentinelPath)} || cat ${shellQuote(sentinelPath)}`],
    "/",
  );
  requireZeroExit(`read sentinel ${sentinelPath}`, result);
  if (!result.stdout.trim()) return { status: "missing" };
  try {
    const parsed = JSON.parse(result.stdout) as {
      providerLeaseId?: unknown;
      acquisitionId?: unknown;
      acquisitionFingerprint?: unknown;
      remoteCwd?: unknown;
    };
    if (parsed.providerLeaseId !== input.providerLeaseId || parsed.remoteCwd !== input.remoteCwd) {
      return { status: "invalid" };
    }
    if (typeof parsed.acquisitionId === "string" && parsed.acquisitionId.length > 0) {
      return {
        status: "owned",
        acquisitionId: parsed.acquisitionId,
        acquisitionFingerprint:
          typeof parsed.acquisitionFingerprint === "string" && parsed.acquisitionFingerprint.length > 0
            ? parsed.acquisitionFingerprint
            : `migrated:${input.providerLeaseId}:${parsed.acquisitionId}`,
        legacy: false,
      };
    }
    return parsed.acquisitionId === undefined
      ? {
          status: "owned",
          acquisitionId: null,
          acquisitionFingerprint: `legacy:${input.providerLeaseId}`,
          legacy: true,
        }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

function ownershipConflict(message: string): Response {
  return toErrorResponse(409, "acquisition_conflict", message);
}

async function migrateSentinelOwnership(
  sandbox: Sandbox,
  input: {
    providerLeaseId: string;
    requestedAcquisitionId: string;
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
): Promise<{ status: "owned"; ownership: LeaseOwnershipRecord } | { status: "conflict" }> {
  const sentinel = await readSentinelOwnership(sandbox, input);
  if (sentinel.status !== "owned") return { status: "conflict" };

  let acquisitionId = sentinel.acquisitionId;
  if (acquisitionId === null) {
    acquisitionId = input.requestedAcquisitionId || `legacy:${input.providerLeaseId}`;
  } else if (!input.requestedAcquisitionId || input.requestedAcquisitionId !== acquisitionId) {
    return { status: "conflict" };
  }

  const claim = await sandbox.claimLeaseOwnership({
    providerLeaseId: input.providerLeaseId,
    acquisitionId,
    acquisitionFingerprint: sentinel.acquisitionFingerprint,
  });
  if (claim.status !== "claimed" && claim.status !== "replayed") return { status: "conflict" };
  return { status: "owned", ownership: claim.ownership };
}

async function resolveOwnedLease(
  sandbox: Sandbox,
  input: {
    providerLeaseId: string;
    requestedAcquisitionId: string;
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
    allowSentinelMigration?: boolean;
    allowDestroying?: boolean;
  },
): Promise<{ status: "owned"; ownership: LeaseOwnershipRecord } | { status: "conflict" }> {
  const ownership = await sandbox.readLeaseOwnership();
  if (ownership.status === "owned" || (input.allowDestroying && ownership.status === "destroying")) {
    if (
      ownership.ownership.providerLeaseId !== input.providerLeaseId
      || !input.requestedAcquisitionId
      || ownership.ownership.acquisitionId !== input.requestedAcquisitionId
    ) {
      return { status: "conflict" };
    }
    return { status: "owned", ownership: ownership.ownership };
  }
  if (ownership.status !== "missing" || !input.allowSentinelMigration) return { status: "conflict" };
  return await migrateSentinelOwnership(sandbox, input);
}

type DestroyOwnedLeaseResult = "destroyed" | "completed" | "in_progress" | "missing" | "invalid" | "conflict";

async function destroyOwnedLease(
  sandbox: Sandbox,
  identity: LeaseOwnershipIdentity,
): Promise<DestroyOwnedLeaseResult> {
  const destructionId = crypto.randomUUID();
  const destruction = await sandbox.beginLeaseDestruction(identity, destructionId);
  if (destruction.status === "completed") return "completed";
  if (destruction.status !== "started") return destruction.status;

  const startedDestructionId = destruction.ownership.destructionId;
  if (!startedDestructionId) {
    throw new Error(`Cloudflare sandbox ${identity.providerLeaseId} entered destruction without an operation ID.`);
  }
  await completeStartedDestruction(sandbox, identity, startedDestructionId);
  return "destroyed";
}

async function destroyOwnedLeaseAfterExecution(
  sandbox: Sandbox,
  identity: LeaseOwnershipIdentity,
  executionId: string,
): Promise<DestroyOwnedLeaseResult> {
  const destructionId = crypto.randomUUID();
  const destruction = await sandbox.beginLeaseDestructionAfterExecution(identity, executionId, destructionId);
  if (destruction.status === "completed") return "completed";
  if (destruction.status !== "started") return destruction.status;

  const startedDestructionId = destruction.ownership.destructionId;
  if (!startedDestructionId) {
    throw new Error(`Cloudflare sandbox ${identity.providerLeaseId} entered destruction without an operation ID.`);
  }
  await completeStartedDestruction(sandbox, identity, startedDestructionId);
  return "destroyed";
}

async function completeStartedDestruction(
  sandbox: Sandbox,
  identity: LeaseOwnershipIdentity,
  destructionId: string,
): Promise<void> {
  // A rejected provider call has an indeterminate outcome: the sandbox may
  // already be gone even though the response was lost. Keep ownership in the
  // destroying state so no later request can treat that sandbox as usable.
  await sandbox.destroy();

  const completed = await sandbox.completeLeaseDestruction(identity, destructionId);
  if (completed.status !== "completed") {
    throw new Error(
      `Cloudflare sandbox ${identity.providerLeaseId} was destroyed, but its ownership completion could not be recorded (${completed.status}).`,
    );
  }
}

async function destroyRequestedLease(
  sandbox: Sandbox,
  input: {
    providerLeaseId: string;
    requestedAcquisitionId: string;
    remoteCwd: string;
    sessionStrategy: SessionStrategy;
    sessionId: string;
    timeoutMs: number;
  },
): Promise<DestroyOwnedLeaseResult> {
  if (input.requestedAcquisitionId) {
    return await destroyOwnedLease(sandbox, {
      providerLeaseId: input.providerLeaseId,
      acquisitionId: input.requestedAcquisitionId,
    });
  }

  const legacyIdentity = {
    providerLeaseId: input.providerLeaseId,
    acquisitionId: `legacy:${input.providerLeaseId}`,
  };
  const legacyRetry = await destroyOwnedLease(sandbox, legacyIdentity);
  if (legacyRetry !== "missing") return legacyRetry;

  const migrated = await resolveOwnedLease(sandbox, {
    ...input,
    allowSentinelMigration: true,
  });
  if (migrated.status === "conflict") return "conflict";
  return await destroyOwnedLease(sandbox, migrated.ownership);
}

async function completeLeaseExecution(
  sandbox: Sandbox,
  identity: LeaseOwnershipIdentity,
  executionId: string,
  completeSetup = false,
): Promise<void> {
  const completed = await sandbox.completeLeaseExecution(identity, executionId, completeSetup);
  if (completed.status === "destruction_started") {
    const destructionId = completed.ownership.destructionId;
    if (!destructionId) {
      throw new Error(`Cloudflare sandbox ${identity.providerLeaseId} entered destruction without an operation ID.`);
    }
    await completeStartedDestruction(sandbox, identity, destructionId);
    return;
  }
  if (completed.status !== "completed") {
    throw new Error(
      `Cloudflare sandbox ${identity.providerLeaseId} execution completed, but its ownership fence could not be released (${completed.status}).`,
    );
  }
}

function executionFenceExpiry(): string {
  return new Date(Date.now() + EXECUTION_FENCE_TTL_MS).toISOString();
}

interface ExecutionFenceRenewal {
  failure: Promise<never>;
  stop: () => Promise<void>;
}

function startExecutionFenceRenewal(
  sandbox: Sandbox,
  identity: LeaseOwnershipIdentity,
  executionId: string,
): ExecutionFenceRenewal {
  let stopped = false;
  let renewalFailure: unknown;
  let rejectFailure!: (reason?: unknown) => void;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  let pendingRenewal = Promise.resolve();
  const timer = setInterval(() => {
    pendingRenewal = pendingRenewal
      .then(async () => {
        const renewed = await sandbox.renewLeaseExecution(
          identity,
          executionId,
          executionFenceExpiry(),
        );
        if (renewed.status !== "renewed") {
          throw new Error(
            `Cloudflare sandbox ${identity.providerLeaseId} execution fence could not be renewed (${renewed.status}).`,
          );
        }
      })
      .catch((error) => {
        if (renewalFailure === undefined) {
          renewalFailure = error;
          rejectFailure(error);
        }
      });
  }, EXECUTION_FENCE_RENEW_INTERVAL_MS);

  return {
    failure,
    stop: async () => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await pendingRenewal;
      if (renewalFailure !== undefined) throw renewalFailure;
    },
  };
}

async function finalizeLeaseExecution(
  sandbox: Sandbox,
  identity: LeaseOwnershipIdentity,
  executionId: string,
  renewal: ExecutionFenceRenewal,
  destroyAfterExecution = false,
  completeSetup = false,
): Promise<void> {
  let renewalError: unknown;
  try {
    await renewal.stop();
  } catch (error) {
    renewalError = error;
  }
  try {
    if (destroyAfterExecution || renewalError !== undefined) {
      const destroyed = await destroyOwnedLeaseAfterExecution(sandbox, identity, executionId);
      if (destroyed !== "destroyed" && destroyed !== "completed" && destroyed !== "in_progress") {
        throw new Error(
          `Cloudflare sandbox ${identity.providerLeaseId} timed out, but coordinated destruction failed (${destroyed}).`,
        );
      }
    } else {
      await completeLeaseExecution(sandbox, identity, executionId, completeSetup);
    }
  } catch (cleanupError) {
    if (renewalError !== undefined) {
      throw new AggregateError(
        [renewalError, cleanupError],
        `Cloudflare sandbox ${identity.providerLeaseId} execution fence renewal and cleanup failed.`,
      );
    }
    throw cleanupError;
  }
  if (renewalError !== undefined) throw renewalError;
}

async function runFencedOperation<T>(
  sandbox: Sandbox,
  identity: LeaseOwnershipIdentity,
  executionId: string,
  renewal: ExecutionFenceRenewal,
  operation: () => Promise<T>,
  options?: {
    destroyAfterExecution?: (result: T) => boolean;
    destroyOnError?: boolean;
    completeSetupOnSuccess?: boolean;
  },
): Promise<T> {
  let result: T;
  let renewalFailed = false;
  const operationPromise = Promise.resolve().then(operation);
  try {
    result = await Promise.race([
      operationPromise,
      renewal.failure.catch(async (error) => {
        renewalFailed = true;
        let quarantineError: unknown;
        try {
          const quarantined = await sandbox.quarantineLeaseExecution(
            identity,
            executionId,
            crypto.randomUUID(),
          );
          if (quarantined.status !== "quarantined" && quarantined.status !== "in_progress") {
            throw new Error(
              `Cloudflare sandbox ${identity.providerLeaseId} could not be quarantined after execution fence renewal failed (${quarantined.status}).`,
            );
          }
        } catch (quarantineFailure) {
          quarantineError = quarantineFailure;
        }
        // The Cloudflare execution API does not expose an abort primitive.
        // Quarantine ownership immediately, but keep the execution fence and
        // sandbox intact until the in-flight operation settles.
        await operationPromise.catch(() => undefined);
        if (quarantineError !== undefined) {
          throw new AggregateError(
            [error, quarantineError],
            `Cloudflare sandbox ${identity.providerLeaseId} execution fence renewal and quarantine failed.`,
          );
        }
        throw error;
      }),
    ]);
  } catch (error) {
    try {
      await finalizeLeaseExecution(
        sandbox,
        identity,
        executionId,
        renewalFailed
          ? { ...renewal, stop: async () => { await renewal.stop().catch(() => undefined); } }
          : renewal,
        (options?.destroyOnError ?? false) || renewalFailed,
      );
    } catch (cleanupError) {
      const operationMessage = error instanceof Error ? error.message : String(error);
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new AggregateError(
        [error, cleanupError],
        `Cloudflare sandbox ${identity.providerLeaseId} operation failed (${operationMessage}), and execution fence cleanup failed (${cleanupMessage}).`,
      );
    }
    throw error;
  }
  await finalizeLeaseExecution(
    sandbox,
    identity,
    executionId,
    renewal,
    options?.destroyAfterExecution?.(result) ?? false,
    options?.completeSetupOnSuccess ?? false,
  );
  return result;
}

export async function handleBridgeRequest(request: Request, env: BridgeEnv): Promise<Response> {
  if (!(await isAuthorizedRequest(request, env.BRIDGE_AUTH_TOKEN))) {
    return toErrorResponse(401, "unauthorized", "Missing or invalid bridge bearer token.");
  }

  const url = new URL(request.url);
  const pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/^\/api\/paperclip-sandbox\/v2(?=\/)/, "/api/paperclip-sandbox/v1");

  if (request.method === "GET" && pathname === "/api/paperclip-sandbox/v1/health") {
    return toJsonResponse({
      ok: true,
      provider: "cloudflare",
      bridgeVersion: "0.1.0",
      capabilities: {
        acquisitionReplay: true,
        scopedReuse: true,
        reuseLease: true,
        namedSessions: true,
        previewUrls: false,
      },
    });
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/probe") {
    const body = await readJson<ProbeRequestBody>(request);
    const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
    const keepAlive = readBoolean(body.keepAlive, false);
    const sleepAfter = readString(body.sleepAfter, "10m");
    const normalizeId = readBoolean(body.normalizeId, true);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
    const sandboxId = buildLeaseSandboxId({
      environmentId: "probe",
      runId: `probe-${Date.now()}-${crypto.randomUUID()}`,
      reuseLease: false,
      normalizeId,
    });

    const sandbox = await resolveSandbox(env, sandboxId, { keepAlive, sleepAfter, normalizeId });
    await applySandboxKeepAlive(sandbox, keepAlive);
    try {
      await ensureWorkspace(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs });
      const result = await executeInSandbox({
        sandbox,
        command: "pwd",
        cwd: remoteCwd,
        timeoutMs,
        sessionStrategy,
        sessionId,
      });
      return toJsonResponse({
        ok: true,
        summary: "Connected to Cloudflare sandbox bridge.",
        metadata: {
          provider: "cloudflare",
          remoteCwd,
          namedSessions: sessionStrategy === "named",
          stdout: result.stdout,
        },
      });
    } finally {
      await sandbox.destroy();
    }
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/leases/acquire") {
    const body = await readJson<AcquireLeaseRequestBody>(request);
    const acquisitionId = readString(body.acquisitionId, "");
    const environmentId = readString(body.environmentId, "");
    const runId = readString(body.runId, "");
    if (!acquisitionId || !environmentId || !runId) {
      return toErrorResponse(
        400,
        "invalid_request",
        "acquisitionId, environmentId, and runId are required.",
      );
    }

    const reuseLease = readBoolean(body.reuseLease, false);
    const keepAlive = readBoolean(body.keepAlive, false);
    const sleepAfter = readString(body.sleepAfter, "10m");
    const normalizeId = readBoolean(body.normalizeId, true);
    const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
    const reuseScopeId = readString(body.reuseScopeId, "") || null;
    const acquisitionFingerprint = buildAcquisitionFingerprint({
      environmentId,
      runId,
      issueId: readString(body.issueId, "") || null,
      remoteCwd,
      sessionStrategy,
      sessionId,
      keepAlive,
      sleepAfter,
      normalizeId,
      reuseLease,
      reuseScopeId,
    });
    const providerLeaseId = buildLeaseSandboxId({
      acquisitionId,
      environmentId,
      reuseScopeId: reuseScopeId ?? undefined,
      runId,
      reuseLease,
      normalizeId,
    });
    const sandbox = await resolveSandbox(env, providerLeaseId, { keepAlive, sleepAfter, normalizeId });
    let claimedOwnership: LeaseOwnershipRecord | null = null;
    try {
      const acquisitionExecutionId = crypto.randomUUID();
      const claim = await sandbox.claimLeaseOwnership({
        providerLeaseId,
        acquisitionId,
        acquisitionFingerprint,
        setupExecutionId: acquisitionExecutionId,
        setupExpiresAt: executionFenceExpiry(),
      });
      if (claim.status === "in_progress") {
        return toErrorResponse(
          503,
          "acquisition_in_progress",
          `Cloudflare sandbox ${providerLeaseId} setup is still in progress.`,
          { providerLeaseId },
        );
      }
      if (claim.status !== "claimed" && claim.status !== "replayed") {
        return ownershipConflict(
          `Refusing to adopt Cloudflare sandbox ${providerLeaseId}: acquisition ownership does not match ${acquisitionId}.`,
        );
      }
      if (claim.status === "claimed") {
        claimedOwnership = claim.ownership;
        const stopAcquisitionFenceRenewal = startExecutionFenceRenewal(
          sandbox,
          claim.ownership,
          acquisitionExecutionId,
        );
        await runFencedOperation(
          sandbox,
          claim.ownership,
          acquisitionExecutionId,
          stopAcquisitionFenceRenewal,
          async () => {
            await applySandboxKeepAlive(sandbox, keepAlive);
            await writeSentinelMirror(sandbox, {
              providerLeaseId,
              acquisitionId,
              acquisitionFingerprint,
              remoteCwd,
              sessionStrategy,
              sessionId,
              keepAlive,
              sleepAfter,
              normalizeId,
              resumedLease: false,
              timeoutMs,
            });
          },
          { destroyOnError: true, completeSetupOnSuccess: true },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let cleanupFailed = false;
      if (claimedOwnership) {
        try {
          const destroyed = await destroyOwnedLease(sandbox, claimedOwnership);
          cleanupFailed = destroyed !== "destroyed" && destroyed !== "completed";
        } catch {
          cleanupFailed = true;
        }
      }
      return toErrorResponse(
        500,
        "acquisition_failed",
        message,
        cleanupFailed ? { providerLeaseId } : undefined,
      );
    }

    return toJsonResponse({
      providerLeaseId,
      metadata: {
        provider: "cloudflare",
        acquisitionId,
        remoteCwd,
        sandboxId: providerLeaseId,
        sessionStrategy,
        sessionId,
        keepAlive,
        sleepAfter,
        normalizeId,
        reuseLease,
        reuseScopeId,
        resumedLease: false,
      },
    });
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/leases/resume") {
    const body = await readJson<ResumeLeaseRequestBody>(request);
    if (!body.providerLeaseId) {
      return toErrorResponse(400, "invalid_request", "providerLeaseId is required.");
    }
    const expectedAcquisitionId = readString(body.acquisitionId, "");
    const keepAlive = readBoolean(body.keepAlive, false);
    const sleepAfter = readString(body.sleepAfter, "10m");
    const normalizeId = readBoolean(body.normalizeId, true);
    const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
    const sandbox = await resolveSandbox(env, body.providerLeaseId, { keepAlive, sleepAfter, normalizeId });
    // Resume always reattaches to a providerLeaseId the operator already
    // owns, so we deliberately do NOT destroy on failure here — the operator
    // has the ID and can issue an explicit release/destroy. Calling
    // `getSandbox` is idempotent on the Sandbox SDK side (no new sandbox is
    // created), so a failed resume doesn't leak a *new* sandbox.
    const containerState = await sandbox.readContainerState();
    if (containerState.status !== "healthy") {
      return toErrorResponse(409, "sandbox_state_lost", "Cloudflare sandbox state is no longer available.");
    }
    const resolvedOwnership = await resolveOwnedLease(sandbox, {
      providerLeaseId: body.providerLeaseId,
      requestedAcquisitionId: expectedAcquisitionId,
      remoteCwd,
      sessionStrategy,
      sessionId,
      timeoutMs,
      allowSentinelMigration: true,
    });
    if (resolvedOwnership.status === "conflict") {
      return toErrorResponse(409, "sandbox_state_lost", "Cloudflare sandbox state is no longer available.");
    }
    const sentinelOwnership = await readSentinelOwnership(sandbox, {
      providerLeaseId: body.providerLeaseId,
      remoteCwd,
      sessionStrategy,
      sessionId,
      timeoutMs,
    });
    const sentinelMatchesOwnership = sentinelOwnership.status === "owned"
      && sentinelOwnership.acquisitionFingerprint === resolvedOwnership.ownership.acquisitionFingerprint
      && (sentinelOwnership.legacy
        ? sentinelOwnership.acquisitionId === null
        : sentinelOwnership.acquisitionId === resolvedOwnership.ownership.acquisitionId);
    if (!sentinelMatchesOwnership) {
      return toErrorResponse(409, "sandbox_state_lost", "Cloudflare sandbox state is no longer available.");
    }
    const resumeExecutionId = crypto.randomUUID();
    const resumeExecution = await sandbox.beginLeaseExecution(
      resolvedOwnership.ownership,
      resumeExecutionId,
      executionFenceExpiry(),
    );
    if (resumeExecution.status !== "started" && resumeExecution.status !== "replayed") {
      return toErrorResponse(409, "sandbox_state_lost", "Cloudflare sandbox ownership changed during resume.");
    }
    const stopResumeFenceRenewal = startExecutionFenceRenewal(
      sandbox,
      resolvedOwnership.ownership,
      resumeExecutionId,
    );
    return await runFencedOperation(
      sandbox,
      resolvedOwnership.ownership,
      resumeExecutionId,
      stopResumeFenceRenewal,
      async () => {
        await applySandboxKeepAlive(sandbox, keepAlive);
        await ensureWorkspace(sandbox, { remoteCwd, sessionStrategy, sessionId, timeoutMs });
        await writeSentinelMirror(sandbox, {
          providerLeaseId: body.providerLeaseId!,
          acquisitionId: resolvedOwnership.ownership.acquisitionId,
          acquisitionFingerprint: resolvedOwnership.ownership.acquisitionFingerprint,
          remoteCwd,
          sessionStrategy,
          sessionId,
          keepAlive,
          sleepAfter,
          normalizeId,
          resumedLease: true,
          timeoutMs,
        });

        return toJsonResponse({
          providerLeaseId: body.providerLeaseId,
          metadata: {
            provider: "cloudflare",
            acquisitionId: resolvedOwnership.ownership.acquisitionId,
            remoteCwd,
            sandboxId: body.providerLeaseId,
            sessionStrategy,
            sessionId,
            keepAlive,
            sleepAfter,
            normalizeId,
            resumedLease: true,
          },
        });
      },
    );
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/leases/release") {
    const body = await readJson<ReleaseLeaseRequestBody>(request);
    if (!body.providerLeaseId) {
      return toJsonResponse({ ok: true });
    }
    const reuseLease = readBoolean(body.reuseLease, false);
    const acquisitionId = readString(body.acquisitionId, "");
    if (!acquisitionId && reuseLease) {
      return toErrorResponse(400, "invalid_request", "acquisitionId is required to release a lease.");
    }
    const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
    const sandbox = await resolveSandbox(env, body.providerLeaseId, {
      keepAlive: readBoolean(body.keepAlive, false),
      sleepAfter: "10m",
      normalizeId: true,
    });
    if (reuseLease) {
      const resolvedOwnership = await resolveOwnedLease(sandbox, {
        providerLeaseId: body.providerLeaseId,
        requestedAcquisitionId: acquisitionId,
        remoteCwd,
        sessionStrategy,
        sessionId,
        timeoutMs,
      });
      if (resolvedOwnership.status === "conflict") {
        return ownershipConflict(`Refusing to release Cloudflare sandbox ${body.providerLeaseId}: acquisition ownership does not match.`);
      }
      const refreshed = await sandbox.updateLeaseOwnership(resolvedOwnership.ownership);
      if (refreshed.status !== "updated") {
        return ownershipConflict(`Refusing to release Cloudflare sandbox ${body.providerLeaseId}: acquisition ownership changed.`);
      }
      return toJsonResponse({ ok: true });
    }
    const destroyed = await destroyRequestedLease(sandbox, {
      providerLeaseId: body.providerLeaseId,
      requestedAcquisitionId: acquisitionId,
      remoteCwd,
      sessionStrategy,
      sessionId,
      timeoutMs,
    });
    if (destroyed !== "destroyed" && destroyed !== "completed") {
      return ownershipConflict(
        `Refusing to release Cloudflare sandbox ${body.providerLeaseId}: acquisition ownership does not match (${destroyed}).`,
      );
    }
    return toJsonResponse({ ok: true });
  }

  if (request.method === "DELETE" && pathname.startsWith("/api/paperclip-sandbox/v1/leases/")) {
    const providerLeaseId = decodeURIComponent(pathname.split("/").pop() ?? "");
    if (providerLeaseId.length === 0) {
      return toErrorResponse(400, "invalid_request", "providerLeaseId path parameter is required.");
    }
    const body = await readJson<DestroyLeaseRequestBody>(request).catch((): DestroyLeaseRequestBody => ({}));
    const remoteCwd = readString(body.requestedCwd, DEFAULT_REMOTE_CWD);
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
    const acquisitionId = readString(body.acquisitionId, "");
    const sandbox = await resolveSandbox(env, providerLeaseId, {
      keepAlive: false,
      sleepAfter: "10m",
      normalizeId: true,
    });
    const destroyed = await destroyRequestedLease(sandbox, {
      providerLeaseId,
      requestedAcquisitionId: acquisitionId,
      remoteCwd,
      sessionStrategy,
      sessionId,
      timeoutMs,
    });
    if (destroyed !== "destroyed" && destroyed !== "completed") {
      return ownershipConflict(
        `Refusing to destroy a Cloudflare sandbox owned by another acquisition (${destroyed}).`,
      );
    }
    return toJsonResponse({ ok: true });
  }

  if (request.method === "POST" && pathname === "/api/paperclip-sandbox/v1/exec") {
    const body = await readJson<ExecuteRequestBody>(request);
    const acquisitionId = readString(body.acquisitionId, "");
    if (!body.providerLeaseId || !acquisitionId || !body.command) {
      return toErrorResponse(400, "invalid_request", "providerLeaseId, acquisitionId, and command are required.");
    }
    const sessionStrategy = readSessionStrategy(body.sessionStrategy);
    const sessionId = readString(body.sessionId, DEFAULT_SESSION_ID);
    const timeoutMs = readInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS);
    const sandbox = await resolveSandbox(env, body.providerLeaseId, {
      keepAlive: false,
      sleepAfter: "10m",
      normalizeId: true,
    });
    const executionIdentity = {
      providerLeaseId: body.providerLeaseId,
      acquisitionId,
    };
    const executionId = crypto.randomUUID();
    const execution = await sandbox.beginLeaseExecution(
      executionIdentity,
      executionId,
      executionFenceExpiry(),
    );
    if (execution.status !== "started" && execution.status !== "replayed") {
      return ownershipConflict(
        `Refusing to execute in Cloudflare sandbox ${body.providerLeaseId}: acquisition ownership does not match.`,
      );
    }
    const stopExecutionFenceRenewal = startExecutionFenceRenewal(
      sandbox,
      executionIdentity,
      executionId,
    );
    if (body.streamOutput === true) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // Heartbeat keeps the SSE response alive during silent stretches
          // (e.g. npm install downloading silently). SSE comment lines (`:`)
          // are ignored by the client parser but keep the underlying HTTP
          // connection from idling out at the Cloudflare edge.
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              // Controller may already be closed; ignore.
            }
          }, 15_000);
          try {
            const result = await runFencedOperation(
              sandbox,
              executionIdentity,
              executionId,
              stopExecutionFenceRenewal,
              async () => await executeInSandbox({
                sandbox,
                command: body.command!,
                args: Array.isArray(body.args) ? body.args.filter((value): value is string => typeof value === "string") : [],
                cwd: typeof body.cwd === "string" ? body.cwd : undefined,
                env: body.env,
                stdin: body.stdin ?? null,
                timeoutMs,
                sessionStrategy,
                sessionId,
                onOutput: async (streamName, data) => {
                  controller.enqueue(encoder.encode(encodeSseEvent(streamName, { data })));
                },
              }),
              {
                destroyAfterExecution: (result) => result.timedOut && sessionStrategy === "default",
              },
            );
            controller.enqueue(encoder.encode(encodeSseEvent("complete", result)));
          } catch (error) {
            controller.enqueue(encoder.encode(encodeSseEvent("error", {
              error: error instanceof Error ? error.message : String(error),
            })));
          } finally {
            clearInterval(heartbeat);
            controller.close();
          }
        },
      });
      return toSseResponse(stream);
    }
    const result = await runFencedOperation(
      sandbox,
      executionIdentity,
      executionId,
      stopExecutionFenceRenewal,
      async () => await executeInSandbox({
        sandbox,
        command: body.command!,
        args: Array.isArray(body.args) ? body.args.filter((value): value is string => typeof value === "string") : [],
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        env: body.env,
        stdin: body.stdin ?? null,
        timeoutMs,
        sessionStrategy,
        sessionId,
      }),
      {
        destroyAfterExecution: (result) => result.timedOut && sessionStrategy === "default",
      },
    );
    return toJsonResponse(result);
  }

  return toErrorResponse(404, "not_found", `No bridge route matched ${request.method} ${pathname}.`);
}
