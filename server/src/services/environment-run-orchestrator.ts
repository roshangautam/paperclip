/**
 * Centralized environment run orchestrator.
 *
 * Owns the full environment lifecycle for a heartbeat run:
 *   1. Resolve selected environment
 *   2. Validate environment is active and allowed
 *   3. Acquire or resume lease
 *   4. Realize workspace in the environment
 *   5. Resolve execution target for the adapter
 *   6. Release / retain / fail lease according to policy
 *   7. Record activity and operator-visible status
 *
 * Heartbeat callers delegate to this service instead of inlining
 * environment resolution, lease management, workspace realization,
 * and transport logic.
 */

import type { Db } from "@paperclipai/db";
import type {
  Environment,
  EnvironmentLease,
  EnvironmentLeasePolicy,
  EnvironmentLeaseStatus,
  ExecutionWorkspace,
  ExecutionWorkspaceConfig,
} from "@paperclipai/shared";
import { environmentService } from "./environments.js";
import {
  environmentRuntimeService,
  buildEnvironmentLeaseContext,
  type EnvironmentRuntimeLeaseRecord,
  type EnvironmentRuntimeService,
} from "./environment-runtime.js";
import {
  resolveEnvironmentExecutionTarget,
  resolveEnvironmentExecutionTransport,
} from "./environment-execution-target.js";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
  type AdapterRemoteExecutionSpec,
} from "@paperclipai/adapter-utils/execution-target";
import { buildWorkspaceRealizationRequest } from "./workspace-realization.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { logActivity } from "./activity-log.js";
import { parseObject } from "../adapters/utils.js";
import type { RealizedExecutionWorkspace } from "./workspace-runtime.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type EnvironmentErrorCode =
  | "environment_not_found"
  | "environment_inactive"
  | "unsupported_environment"
  | "unsupported_adapter_environment"
  | "probe_failed"
  | "lease_acquire_failed"
  | "workspace_realization_failed"
  | "transport_resolution_failed"
  | "lease_release_failed"
  | "lease_cleanup_failed";

export class EnvironmentRunError extends Error {
  code: EnvironmentErrorCode;
  environmentId?: string;
  driver?: string;
  provider?: string;
  cause?: unknown;

  constructor(
    code: EnvironmentErrorCode,
    message: string,
    details?: {
      environmentId?: string;
      driver?: string;
      provider?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "EnvironmentRunError";
    this.code = code;
    this.environmentId = details?.environmentId;
    this.driver = details?.driver;
    this.provider = details?.provider;
    this.cause = details?.cause;
  }
}

// ---------------------------------------------------------------------------
// Orchestration result types
// ---------------------------------------------------------------------------

export interface EnvironmentAcquisitionResult {
  environment: Environment;
  lease: EnvironmentLease;
  leaseContext: ReturnType<typeof buildEnvironmentLeaseContext>;
  executionTransport: Record<string, unknown> | null;
}

export interface EnvironmentRealizationResult {
  lease: EnvironmentLease;
  workspaceRealization: Record<string, unknown>;
  executionTarget: AdapterExecutionTarget | null;
  remoteExecution: AdapterRemoteExecutionSpec | null;
  persistedExecutionWorkspace: ExecutionWorkspace | null;
}

export interface EnvironmentReleaseResult {
  released: EnvironmentRuntimeLeaseRecord[];
  errors: Array<{ leaseId: string; error: unknown }>;
}

function firstNonEmptyLine(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line) return line;
  }
  return null;
}

function formatProvisionFailureDetail(result: {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): string {
  if (result.timedOut) {
    return "provision command timed out";
  }
  const signal = typeof result.signal === "string" && result.signal.trim().length > 0
    ? ` (signal ${result.signal.trim()})`
    : "";
  const detail = firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout);
  const status = `exit code ${result.exitCode ?? "null"}${signal}`;
  return detail ? `${status}: ${detail}` : status;
}

const TRANSIENT_ENV_REDACTED_VALUE = "***REDACTED***";
const TRANSIENT_ENV_SENSITIVE_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_FILE",
]);

function transientSensitiveEnvEntries(
  env: Record<string, string> | undefined,
): Array<[string, string]> {
  return Object.entries(env ?? {})
    .filter(([key, value]) =>
      TRANSIENT_ENV_SENSITIVE_KEYS.has(key) && value.trim().length > 0)
    .sort(([, a], [, b]) => b.length - a.length);
}

function transientEnvValueVariants(value: string): string[] {
  return Array.from(new Set([value, value.trim()].flatMap((candidate) =>
    [candidate, JSON.stringify(candidate).slice(1, -1)])));
}

function transientEnvValues(env: Record<string, string> | undefined): string[] {
  return Array.from(new Set(
    transientSensitiveEnvEntries(env).flatMap(([, value]) => transientEnvValueVariants(value)),
  )).sort((a, b) => b.length - a.length);
}

function transientEnvKeyInText(
  text: string,
  env: Record<string, string> | undefined,
): string | null {
  return transientSensitiveEnvEntries(env)
    .find(([, value]) => transientEnvValueVariants(value)
      .some((candidate) => text.includes(candidate)))?.[0] ?? null;
}

function redactTransientEnvText(text: string, env: Record<string, string> | undefined): string {
  let redacted = text;
  for (const value of transientEnvValues(env)) {
    redacted = redacted.split(value).join(TRANSIENT_ENV_REDACTED_VALUE);
  }
  return redacted;
}

function readDataStringProperty(
  value: object,
  key: string,
  fallback: string,
): string {
  let current: object | null = value;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return "value" in descriptor && typeof descriptor.value === "string"
        ? descriptor.value
        : fallback;
    }
    current = Object.getPrototypeOf(current);
  }
  return fallback;
}

function redactTransientEnvValue(
  value: unknown,
  env: Record<string, string> | undefined,
  active = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return redactTransientEnvText(value, env);
  if (Array.isArray(value)) {
    if (active.has(value)) return "[Circular]";
    active.add(value);
    const redacted = value.map((entry) => redactTransientEnvValue(entry, env, active));
    active.delete(value);
    return redacted;
  }
  if (value instanceof Error) {
    if (active.has(value)) return "[Circular]";
    active.add(value);
    const message = readDataStringProperty(value, "message", "Unknown error");
    const name = readDataStringProperty(value, "name", "Error");
    const stack = readDataStringProperty(value, "stack", "");
    const redacted = new Error(redactTransientEnvText(message, env));
    redacted.name = redactTransientEnvText(name, env);
    if (stack) redacted.stack = redactTransientEnvText(stack, env);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) continue;
      const redactedKey = redactTransientEnvText(key, env);
      (redacted as unknown as Record<string, unknown>)[redactedKey] = redactTransientEnvValue(
        descriptor.value,
        env,
        active,
      );
    }
    active.delete(value);
    return redacted;
  }
  if (value && typeof value === "object") {
    if (active.has(value)) return "[Circular]";
    active.add(value);
    const redacted = Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(value)).flatMap(([key, descriptor]) => {
        if (!descriptor.enumerable || !("value" in descriptor)) return [];
        return [[
          redactTransientEnvText(key, env),
          redactTransientEnvValue(descriptor.value, env, active),
        ]];
      }),
    );
    active.delete(value);
    return redacted;
  }
  return value;
}

function redactTransientEnvRecord(
  value: Record<string, unknown>,
  env: Record<string, string> | undefined,
): Record<string, unknown> {
  return redactTransientEnvValue(value, env) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function environmentRunOrchestrator(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    environmentRuntime?: EnvironmentRuntimeService;
  } = {},
) {
  const environmentsSvc = environmentService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const environmentRuntime = options.environmentRuntime ?? environmentRuntimeService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });

  /**
   * Resolve the selected environment for a run. The caller passes the concrete
   * selected environment id plus the built-in local fallback id used to lazily
   * ensure the local environment row exists.
   */
  async function resolveEnvironment(input: {
    companyId: string;
    selectedEnvironmentId: string;
    localEnvironmentId: string;
  }): Promise<Environment> {
    const environmentId = input.selectedEnvironmentId || input.localEnvironmentId;

    const environment =
      environmentId === input.localEnvironmentId
        ? await environmentsSvc.ensureLocalEnvironment(input.companyId)
        : await environmentsSvc.getById(environmentId);

    if (!environment) {
      throw new EnvironmentRunError("environment_not_found", `Environment "${environmentId}" not found.`, {
        environmentId,
      });
    }

    if (environment.status !== "active") {
      throw new EnvironmentRunError("environment_inactive", `Environment "${environment.name}" is not active (status: ${environment.status}).`, {
        environmentId: environment.id,
        driver: environment.driver,
      });
    }

    return environment;
  }

  /**
   * Acquire an environment lease for a heartbeat run.
   * Wraps the runtime driver's acquire call with standardized error handling.
   */
  async function acquireLease(input: {
    companyId: string;
    environment: Environment;
    issueId: string | null;
    agentId: string;
    heartbeatRunId: string;
    persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
    adapterType: string | null;
  }): Promise<EnvironmentRuntimeLeaseRecord> {
    try {
      return await environmentRuntime.acquireRunLease(input);
    } catch (err) {
      throw new EnvironmentRunError(
        "lease_acquire_failed",
        `Failed to acquire lease for environment "${input.environment.name}" (${input.environment.driver}): ${err instanceof Error ? err.message : String(err)}`,
        {
          environmentId: input.environment.id,
          driver: input.environment.driver,
          cause: err,
        },
      );
    }
  }

  /**
   * Resolve the execution transport for an adapter based on the acquired lease.
   */
  async function resolveTransport(input: {
    companyId: string;
    adapterType: string;
    environment: Environment;
    leaseMetadata: Record<string, unknown> | null;
  }): Promise<Record<string, unknown> | null> {
    try {
      return await resolveEnvironmentExecutionTransport({
        db,
        companyId: input.companyId,
        adapterType: input.adapterType,
        environment: input.environment,
        leaseMetadata: input.leaseMetadata,
      });
    } catch (err) {
      throw new EnvironmentRunError(
        "transport_resolution_failed",
        `Failed to resolve execution transport for "${input.environment.name}": ${err instanceof Error ? err.message : String(err)}`,
        {
          environmentId: input.environment.id,
          driver: input.environment.driver,
          cause: err,
        },
      );
    }
  }

  /**
   * Full acquisition flow: resolve environment, acquire lease, resolve transport.
   * This is the primary entry point for heartbeat run setup.
   */
  async function acquireForRun(input: {
    companyId: string;
    selectedEnvironmentId: string;
    localEnvironmentId: string;
    adapterType: string;
    issueId: string | null;
    heartbeatRunId: string;
    agentId: string;
    persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
  }): Promise<EnvironmentAcquisitionResult> {
    // Step 1: Resolve environment
    const environment = await resolveEnvironment({
      companyId: input.companyId,
      selectedEnvironmentId: input.selectedEnvironmentId,
      localEnvironmentId: input.localEnvironmentId,
    });

    // Step 2: Acquire lease
    const leaseRecord = await acquireLease({
      companyId: input.companyId,
      environment,
      issueId: input.issueId,
      agentId: input.agentId,
      heartbeatRunId: input.heartbeatRunId,
      persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      adapterType: input.adapterType ?? null,
    });

    // Step 3: Log lease acquisition activity
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.heartbeatRunId,
      action: "environment.lease_acquired",
      entityType: "environment_lease",
      entityId: leaseRecord.lease.id,
      issueId: input.issueId,
      details: {
        environmentId: environment.id,
        driver: environment.driver,
        leasePolicy: leaseRecord.lease.leasePolicy,
        provider: leaseRecord.lease.provider,
        executionWorkspaceId: leaseRecord.leaseContext.executionWorkspaceId,
        issueId: input.issueId,
      },
    });

    // Step 4: Resolve execution transport
    const executionTransport = await resolveTransport({
      companyId: input.companyId,
      adapterType: input.adapterType,
      environment,
      leaseMetadata: leaseRecord.lease.metadata,
    });

    return {
      environment,
      lease: leaseRecord.lease,
      leaseContext: leaseRecord.leaseContext,
      executionTransport,
    };
  }

  /**
   * Realize workspace in the environment and resolve the execution target.
   *
   * After lease acquisition, this method:
   *   1. Builds a workspace realization request
   *   2. Calls the environment runtime driver to realize the workspace
   *   3. Persists realization metadata on the lease and execution workspace
   *   4. Resolves the adapter execution target (local/ssh/sandbox)
   *
   * Returns the updated lease, realization metadata, and the execution
   * target spec that the adapter needs to run.
   */
  async function realizeForRun(input: {
    environment: Environment;
    lease: EnvironmentLease;
    adapterType: string;
    companyId: string;
    issueId: string | null;
    heartbeatRunId: string;
    executionWorkspace: RealizedExecutionWorkspace;
    effectiveExecutionWorkspaceMode: string | null;
    persistedExecutionWorkspace: ExecutionWorkspace | null;
    env?: Record<string, string>;
  }): Promise<EnvironmentRealizationResult> {
    const {
      environment,
      adapterType,
      companyId,
      issueId,
      heartbeatRunId,
      executionWorkspace,
      effectiveExecutionWorkspaceMode,
    } = input;
    let { lease, persistedExecutionWorkspace } = input;

    // Step 1: Build workspace realization request
    const workspaceRealizationRequest = buildWorkspaceRealizationRequest({
      adapterType,
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: persistedExecutionWorkspace?.id ?? null,
      issueId,
      heartbeatRunId,
      requestedMode: persistedExecutionWorkspace?.mode ?? effectiveExecutionWorkspaceMode,
      workspace: executionWorkspace,
      workspaceConfig: persistedExecutionWorkspace?.config ?? null,
    });

    // Step 2: Realize workspace in the environment via the runtime driver
    let workspaceRealization: Record<string, unknown> = {};
    let realizedWorkspaceCwd: string | null = null;
    const leaseRemoteCwd = [
      lease.metadata?.remoteCwd,
      parseObject(lease.metadata?.providerMetadata).remoteCwd,
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
    const configuredRemoteCwd = parseObject(parseObject(environment.config).driverConfig).remoteCwd;
    const pluginRemoteCwd = environment.driver === "plugin" && typeof configuredRemoteCwd === "string"
      ? configuredRemoteCwd.trim() || null
      : null;
    if (
      environment.driver === "local" ||
      environment.driver === "ssh" ||
      environment.driver === "sandbox" ||
      environment.driver === "plugin"
    ) {
      try {
        const workspaceRealizationResult = await environmentRuntime.realizeWorkspace({
          environment,
          lease,
          env: input.env,
          workspace: {
            localPath: executionWorkspace.cwd,
            remotePath: leaseRemoteCwd ?? pluginRemoteCwd ?? undefined,
            mode: persistedExecutionWorkspace?.mode ?? effectiveExecutionWorkspaceMode ?? undefined,
            metadata: {
              workspaceRealizationRequest,
            },
          },
        });
        const candidateRealizedWorkspaceCwd =
          typeof workspaceRealizationResult.cwd === "string" && workspaceRealizationResult.cwd.trim().length > 0
            ? workspaceRealizationResult.cwd.trim()
            : null;
        const cwdTransientEnvKey = candidateRealizedWorkspaceCwd
          ? transientEnvKeyInText(candidateRealizedWorkspaceCwd, input.env)
          : null;
        if (cwdTransientEnvKey) {
          throw new Error(
            `Workspace realization cwd contains transient environment value from ${cwdTransientEnvKey}; providers must return credential-free paths.`,
          );
        }
        realizedWorkspaceCwd = candidateRealizedWorkspaceCwd;
        workspaceRealization = redactTransientEnvRecord(
          parseObject(workspaceRealizationResult.metadata?.workspaceRealization),
          input.env,
        );
      } catch (err) {
        const redactedError = redactTransientEnvValue(err, input.env);
        throw new EnvironmentRunError(
          "workspace_realization_failed",
          `Failed to realize workspace for environment "${environment.name}" (${environment.driver}): ${redactTransientEnvText(err instanceof Error ? err.message : String(err), input.env)}`,
          {
            environmentId: environment.id,
            driver: environment.driver,
            cause: redactedError,
          },
        );
      }
    }

    const provisionCommand = workspaceRealizationRequest.runtimeOverlay.provisionCommand?.trim() ?? "";

    // Step 3: Persist realization metadata on lease and execution workspace
    const hasWorkspaceRealization = Object.keys(workspaceRealization).length > 0;
    const hasRemoteCwd = environment.driver !== "local" && realizedWorkspaceCwd !== null;
    if (hasWorkspaceRealization || hasRemoteCwd) {
      const nextLeaseMetadata = {
        ...(lease.metadata ?? {}),
        ...(hasRemoteCwd ? { remoteCwd: realizedWorkspaceCwd } : {}),
        ...(hasWorkspaceRealization ? { workspaceRealization } : {}),
      };
      const updatedLease = await environmentsSvc.updateLeaseMetadata(lease.id, nextLeaseMetadata);
      if (updatedLease) {
        lease = updatedLease;
      }
      if (persistedExecutionWorkspace && hasWorkspaceRealization) {
        const updatedEw = await executionWorkspacesSvc.update(persistedExecutionWorkspace.id, {
          metadata: {
            ...(persistedExecutionWorkspace.metadata ?? {}),
            workspaceRealizationRequest,
            workspaceRealization,
          },
        });
        if (updatedEw) {
          persistedExecutionWorkspace = updatedEw;
        }
      }
    }

    // Step 4: Resolve execution target for the adapter
    let executionTarget: AdapterExecutionTarget | null;
    try {
      executionTarget = await resolveEnvironmentExecutionTarget({
        db,
        companyId,
        adapterType,
        environment,
        leaseId: lease.id,
        leaseMetadata: (lease.metadata as Record<string, unknown> | null) ?? null,
        lease,
        environmentRuntime,
      });
    } catch (err) {
      throw new EnvironmentRunError(
        "transport_resolution_failed",
        `Failed to resolve execution target for "${environment.name}": ${err instanceof Error ? err.message : String(err)}`,
        {
          environmentId: environment.id,
          driver: environment.driver,
          cause: err,
        },
      );
    }

    if (provisionCommand && environment.driver !== "local") {
      if (
        executionTarget?.kind === "remote" &&
        executionTarget.transport === "sandbox" &&
        executionTarget.syncWorkspace !== false
      ) {
        executionTarget = { ...executionTarget, provisionCommand };
      } else {
        const realizedCwd =
          realizedWorkspaceCwd ??
          leaseRemoteCwd ??
          pluginRemoteCwd ??
          executionWorkspace.cwd;
        try {
          if (
            environment.driver === "plugin" &&
            !realizedWorkspaceCwd &&
            !leaseRemoteCwd &&
            !pluginRemoteCwd
          ) {
            throw new Error("Plugin workspace provisioning requires a remote working directory.");
          }
          const provisionResult = await environmentRuntime.execute({
            environment,
            lease,
            command: "bash",
            args: ["-lc", provisionCommand],
            cwd: realizedCwd,
            workspaceRealization,
            env: {
              SHELL: "/bin/bash",
            },
            timeoutMs: 300_000,
          });
          if (provisionResult.exitCode !== 0 || provisionResult.timedOut) {
            throw new Error(formatProvisionFailureDetail(provisionResult));
          }
        } catch (err) {
          const redactedError = redactTransientEnvValue(err, input.env);
          throw new EnvironmentRunError(
            "workspace_realization_failed",
            `Failed to provision workspace for environment "${environment.name}" (${environment.driver}): ${redactTransientEnvText(err instanceof Error ? err.message : String(err), input.env)}`,
            {
              environmentId: environment.id,
              driver: environment.driver,
              cause: redactedError,
            },
          );
        }
      }
    }

    return {
      lease,
      workspaceRealization,
      executionTarget,
      remoteExecution: adapterExecutionTargetToRemoteSpec(executionTarget),
      persistedExecutionWorkspace,
    };
  }

  /**
   * Release all active leases for a heartbeat run.
   * Tracks cleanup status per lease. Errors during individual lease release
   * are captured but do not prevent other leases from being released.
   * The original run failure (if any) is never hidden by cleanup errors.
   */
  async function releaseForRun(input: {
    heartbeatRunId: string;
    companyId: string;
    agentId: string;
    status?: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
    failureReason?: string;
  }): Promise<EnvironmentReleaseResult> {
    const status = input.status ?? "released";
    const result: EnvironmentReleaseResult = { released: [], errors: [] };

    let releasedLeases: EnvironmentRuntimeLeaseRecord[];
    try {
      releasedLeases = await environmentRuntime.releaseRunLeases(input.heartbeatRunId, status);
    } catch (err) {
      result.errors.push({ leaseId: "*", error: err });
      return result;
    }

    for (const released of releasedLeases) {
      try {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.heartbeatRunId,
          action: "environment.lease_released",
          entityType: "environment_lease",
          entityId: released.lease.id,
          issueId: released.lease.issueId,
          details: {
            environmentId: released.lease.environmentId,
            driver: released.environment.driver,
            leasePolicy: released.lease.leasePolicy,
            provider: released.lease.provider,
            executionWorkspaceId: released.lease.executionWorkspaceId,
            issueId: released.lease.issueId,
            status: released.lease.status,
            cleanupStatus: released.lease.cleanupStatus,
            failureReason: input.failureReason ?? released.lease.failureReason,
          },
        });
      } catch {
        // Activity logging failure should not block lease release
      }
      result.released.push(released);
    }

    return result;
  }

  return {
    resolveEnvironment,
    acquireLease,
    resolveTransport,
    acquireForRun,
    realizeForRun,
    releaseForRun,

    // Expose the underlying runtime for cases that need direct driver access
    runtime: environmentRuntime,
  };
}

export type EnvironmentRunOrchestrator = ReturnType<typeof environmentRunOrchestrator>;
