import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  environmentLeases,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  toolActionRequests,
  toolInvocations,
} from "@paperclipai/db";
import type {
  Environment,
  EnvironmentLease,
  EnvironmentLeaseStatus,
  ExecutionWorkspace,
  PluginEnvironmentConfig,
  SandboxEnvironmentConfig,
} from "@paperclipai/shared";
import type {
  PluginEnvironmentAcquireLeaseErrorData,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentRealizeWorkspaceResult,
} from "@paperclipai/plugin-sdk";
import {
  JsonRpcCallError,
  PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY,
  PLUGIN_RPC_ERROR_CODES,
} from "@paperclipai/plugin-sdk";
import { ensureSshWorkspaceReady } from "@paperclipai/adapter-utils/ssh";
import { environmentService } from "./environments.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import {
  collectEnvironmentSecretRefs,
  parseEnvironmentDriverConfig,
  resolveEnvironmentDriverConfigForRuntime,
  stripSandboxProviderEnvelope,
  type ResolvedEnvironmentSecretVersion,
} from "./environment-config.js";
import {
  createEffectiveRunConfigFingerprints,
  type EffectiveRunConfigFingerprint,
  type EffectiveRunConfigSecretVersionMetadata,
} from "./effective-run-config-fingerprints.js";
import {
  acquireSandboxProviderLease,
  destroySandboxProviderLease,
  findReusableSandboxProviderLeaseId,
  getSandboxProvider as getBuiltinSandboxProvider,
  isBuiltinSandboxProvider,
  releaseSandboxProviderLease,
  resumeSandboxProviderLease,
  sandboxConfigFromLeaseMetadata,
  sandboxConfigFromLeaseMetadataLoose,
} from "./sandbox-provider-runtime.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  destroyPluginEnvironmentLease,
  executePluginEnvironmentCommand,
  realizePluginEnvironmentWorkspace,
  resolvePluginSandboxProviderDriverByKey,
  resolvePluginExecuteRpcTimeoutMs,
  resumePluginEnvironmentLease,
} from "./plugin-environment-driver.js";
import {
  collectSecretRefPaths,
  scopeConfigResourceArrays,
  writeConfigValueAtPath,
} from "./json-schema-secret-refs.js";
import { assertClass3StaticLeaseAllowed, secretService } from "./secrets.js";
import { buildWorkspaceRealizationRecordFromDriverInput } from "./workspace-realization.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { redactPersistedCredentialValues } from "../redaction.js";
import { readSignedToolArgumentsPayload } from "./tool-content-guards.js";
import {
  isAutomaticReusableEnvironmentLeaseCleanupCandidate,
  isReusableEnvironmentLeaseDestroyRequestCandidate,
  PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON,
} from "./reusable-environment-lease-ownership.js";

const PROVIDER_LEASE_IDENTITY_MISSING_ERROR_MESSAGE =
  "Coder lease metadata has no immutable workspace ID; automatic cleanup is unsafe. Delete the legacy workspace manually in Coder.";

function isProviderLeaseIdentityMissingCleanupError(error: unknown): error is JsonRpcCallError {
  return error instanceof JsonRpcCallError
    && error.message === PROVIDER_LEASE_IDENTITY_MISSING_ERROR_MESSAGE;
}

export function buildEnvironmentLeaseContext(input: {
  persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
}) {
  return {
    executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
    executionWorkspaceMode: input.persistedExecutionWorkspace?.mode ?? null,
  };
}

function secretRefContainerPaths(paths: Iterable<string>): Set<string> {
  const containers = new Set<string>();
  for (const path of paths) {
    const segments = path.split(".");
    for (let length = 1; length < segments.length; length += 1) {
      containers.add(segments.slice(0, length).join("."));
    }
  }
  return containers;
}

function stripSecretRefsFromPluginConfigSnapshot(input: {
  config: Record<string, unknown> | null | undefined;
  schema: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  let sanitized = structuredClone(input.config ?? {}) as Record<string, unknown>;
  // A schema-governed config snapshot is reconstructed on reuse by re-inserting
  // secret-refs at DB-bound config paths, so structure must be preserved and only
  // schema-declared secret values removed. Without a schema there is no safe
  // reconstruction contract, so fall back to value-level credential redaction.
  if (!input.schema) {
    return redactPersistedCredentialValues(sanitized) as Record<string, unknown>;
  }
  for (const path of collectSecretRefPaths(input.schema, sanitized)) {
    sanitized = writeConfigValueAtPath(sanitized, path, undefined);
  }
  return sanitized;
}

function sanitizePluginProviderLeaseMetadata(input: {
  metadata: Record<string, unknown> | null | undefined;
  schema: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  let sanitized = structuredClone(input.metadata ?? {}) as Record<string, unknown>;
  // Provider-returned lease metadata is an untrusted persistence boundary: the
  // config schema identifies restorable secret-ref paths but does not constrain
  // arbitrary fields a provider returns, so remove declared refs and then redact
  // residual credential-shaped values without collapsing reuse-critical structure.
  const secretRefPaths = collectSecretRefPaths(input.schema, sanitized);
  for (const path of secretRefPaths) {
    sanitized = writeConfigValueAtPath(sanitized, path, undefined);
  }
  return redactPersistedCredentialValues(sanitized, {
    preserveContainerPaths: secretRefContainerPaths(secretRefPaths),
  }) as Record<string, unknown>;
}

export interface EnvironmentDriverAcquireInput {
  companyId: string;
  environment: Environment;
  issueId: string | null;
  agentId: string | null;
  /**
   * UUID of the owning heartbeat run, or null for ad-hoc invocations
   * (e.g. operator-initiated `Test` probes) that are not tied to a run.
   * Null leases must be released by id via `getDriver(...).releaseRunLease`
   * since `releaseRunLeases(heartbeatRunId)` cannot find them.
   */
  heartbeatRunId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceMode: ExecutionWorkspace["mode"] | null;
  /**
   * The harness/adapter type for this run (the agent's adapter). Drivers that
   * materialize a per-run sandbox use it to select the runtime image so a single
   * environment can serve mixed harnesses; null falls back to the environment's
   * configured default adapter.
   */
  adapterType: string | null;
  /**
   * Force applying the active custom-image template even when issueId and
   * heartbeatRunId are null. Operator-initiated `Test` probes set this so the
   * probe uses the operator-prepared custom image for the runtime lease instead
   * of the base image, matching what real agent runs do.
   */
  applyCustomImageTemplate?: boolean;
}

export interface EnvironmentDriverReleaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
  cleanupClaimId?: string;
}

const REALIZATION_CREDENTIAL_ENV_KEYS = new Set([
  "GITHUB_APP_ID",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY_FILE",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

// The agent that owns a realization's forwarded credentials, or null when no
// agent-scoped realization credentials were supplied. Used to stamp the
// heartbeat reuse ownership marker so a workspace realized with one agent's
// credentials is not reused by another agent.
function resolveRealizationCredentialOwnerAgentId(input: {
  lease: Pick<EnvironmentLease, "metadata">;
  env?: Record<string, string>;
}): string | null {
  const env = input.env ?? {};
  const suppliesCredentials = Object.entries(env).some(
    ([key, value]) => REALIZATION_CREDENTIAL_ENV_KEYS.has(key) && typeof value === "string" && value.length > 0,
  );
  if (!suppliesCredentials) return null;
  return readString(input.lease.metadata?.agentId);
}

// Non-empty forwarded env values long enough to be a credential rather than a
// short identifier. Passed to the realization record builder so any forwarded
// token a provider smuggles back into a returned path is stripped before it
// persists. The length gate avoids over-redacting short path segments.
function resolveForwardedCredentialValues(input: { env?: Record<string, string> }): string[] {
  const env = input.env ?? {};
  const values: string[] = [];
  for (const value of Object.values(env)) {
    if (typeof value === "string" && value.trim().length >= 8) values.push(value);
  }
  return values;
}

function resolvePluginSandboxRpcTimeoutMs(config: Record<string, unknown>): number | undefined {
  const timeoutCandidates = [
    typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
    typeof config.bridgeRequestTimeoutMs === "number" ? config.bridgeRequestTimeoutMs : undefined,
  ]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));

  if (timeoutCandidates.length === 0) {
    return undefined;
  }

  return resolvePluginExecuteRpcTimeoutMs({
    requestedTimeoutMs: Math.max(...timeoutCandidates),
    config,
  });
}

export interface EnvironmentDriverLeaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  failureReason?: string;
  cleanupClaimId?: string;
}

export interface EnvironmentDriverRealizeWorkspaceInput extends EnvironmentDriverLeaseInput {
  env?: Record<string, string>;
  workspace: {
    localPath?: string;
    remotePath?: string;
    mode?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface EnvironmentDriverExecuteInput extends EnvironmentDriverLeaseInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  workspaceRealization?: Record<string, unknown>;
}

export interface EnvironmentRuntimeDriver {
  readonly driver: string;
  acquireRunLease(input: EnvironmentDriverAcquireInput): Promise<EnvironmentLease>;
  releaseRunLease(input: EnvironmentDriverReleaseInput): Promise<EnvironmentLease | null>;
  recoverPendingAcquisition?(input: {
    environment: Environment;
    lease: EnvironmentLease;
    cleanupClaimId: string;
  }): Promise<EnvironmentLease>;
  resumeRunLease?(input: EnvironmentDriverLeaseInput): Promise<PluginEnvironmentLease | EnvironmentLease | null>;
  destroyRunLease?(input: EnvironmentDriverLeaseInput): Promise<EnvironmentLease | null>;
  realizeWorkspace?(input: EnvironmentDriverRealizeWorkspaceInput): Promise<PluginEnvironmentRealizeWorkspaceResult>;
  execute?(input: EnvironmentDriverExecuteInput): Promise<PluginEnvironmentExecuteResult>;
}

export interface EnvironmentRuntimeLeaseRecord {
  environment: Environment;
  lease: EnvironmentLease;
  leaseContext: ReturnType<typeof buildEnvironmentLeaseContext>;
}

const DEFAULT_PLUGIN_SANDBOX_WORKER_READY_TIMEOUT_MS = 5_000;
const DEFAULT_PLUGIN_SANDBOX_WORKER_READY_POLL_MS = 100;
// Bounded lifetime for the in-memory sandbox runtime-config cache. Entries hold
// resolved lease credentials, so they must not outlive the lease. Because a
// lease can be released by a different runtime-service instance (whose eviction
// path never runs here), a TTL and size cap guarantee released-lease secrets
// cannot be retained for the lifetime of this process.
const SANDBOX_RUNTIME_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
const SANDBOX_RUNTIME_CONFIG_CACHE_MAX_ENTRIES = 256;
const SANDBOX_CLEANUP_RETRY_DELAY_MS = 5 * 60 * 1000;
const SANDBOX_CLEANUP_CLAIM_STALE_MS = 5 * 60 * 1000;
const SANDBOX_CLEANUP_CLAIM_RENEW_MS = 60 * 1000;
const SANDBOX_CLEANUP_RETRY_BATCH_SIZE = 10;
const PENDING_CLEANUP_RELEASE_STATUS_KEY = "pendingCleanupReleaseStatus";

function withoutCleanupVerification(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const copy = { ...metadata };
  delete copy[PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY];
  return copy;
}

const PLUGIN_SANDBOX_PROVIDER_CONFIG_KEY = "sandboxProviderConfig";
const LEASE_SCOPED_SECRET_BINDINGS_KEY = "leaseScopedSecretBindings";
const SANDBOX_ACQUISITION_CONTEXT_KEY = "sandboxAcquisition";
const SANDBOX_ACQUISITION_ID_KEY = "sandboxAcquisitionId";
const SANDBOX_LEASE_RESERVATION_KEY = "sandboxLeaseReservation";

function readPluginAcquireLeaseErrorData(
  error: unknown,
): PluginEnvironmentAcquireLeaseErrorData | null {
  if (
    !(error instanceof JsonRpcCallError) ||
    error.code !== PLUGIN_RPC_ERROR_CODES.WORKER_ERROR ||
    !error.data ||
    typeof error.data !== "object" ||
    Array.isArray(error.data)
  ) {
    return null;
  }

  const providerLeaseId = (error.data as Partial<PluginEnvironmentAcquireLeaseErrorData>).providerLeaseId;
  if (typeof providerLeaseId !== "string" || providerLeaseId.trim().length === 0) return null;
  const cleanupVerifiedAcquisitionId =
    (error.data as Partial<PluginEnvironmentAcquireLeaseErrorData>).cleanupVerifiedAcquisitionId;
  return {
    providerLeaseId,
    ...(typeof cleanupVerifiedAcquisitionId === "string"
      ? { cleanupVerifiedAcquisitionId }
      : {}),
  };
}

type SandboxAcquisitionContext = {
  version: 1;
  kind: "builtin" | "plugin";
  provider: string;
  pluginId?: string;
  pluginKey?: string;
  pluginPackageName?: string;
  pluginVersion?: string;
  pluginSupportsAcquisitionReplay?: boolean;
  config: Record<string, unknown>;
  runId: string;
  workspaceMode: string | null;
  agentId: string | null;
  executionWorkspaceId: string | null;
  adapterType: string | null;
  applyCustomImageTemplate: boolean;
  customImageReplay?: SandboxCustomImageReplay | null;
  reusableProviderLeaseId: string | null;
  leaseFingerprint: Record<string, unknown> | null;
};

type SandboxCustomImageReplay = {
  version: 1;
  set: Record<string, unknown>;
  unset: string[];
};

function isSafeSandboxReplayConfigField(value: string): boolean {
  return value.length > 0
    && value !== "provider"
    && value !== "__proto__"
    && value !== "constructor"
    && value !== "prototype";
}

function buildSandboxCustomImageReplay(input: {
  storedConfig: SandboxEnvironmentConfig;
  runtimeConfig: SandboxEnvironmentConfig;
  schema?: Record<string, unknown> | null;
}): SandboxCustomImageReplay | null {
  const storedConfig = stripSecretRefsFromPluginConfigSnapshot({
    config: input.storedConfig as unknown as Record<string, unknown>,
    schema: input.schema,
  });
  const runtimeConfig = stripSecretRefsFromPluginConfigSnapshot({
    config: input.runtimeConfig as unknown as Record<string, unknown>,
    schema: input.schema,
  });
  const setEntries: Array<[string, unknown]> = [];
  const unset: string[] = [];

  for (const field of new Set([...Object.keys(storedConfig), ...Object.keys(runtimeConfig)])) {
    if (!isSafeSandboxReplayConfigField(field)) continue;
    const storedHasField = Object.prototype.hasOwnProperty.call(storedConfig, field);
    const runtimeHasField = Object.prototype.hasOwnProperty.call(runtimeConfig, field);
    if (
      storedHasField === runtimeHasField &&
      isDeepStrictEqual(storedConfig[field], runtimeConfig[field])
    ) {
      continue;
    }
    if (runtimeHasField) {
      setEntries.push([field, structuredClone(runtimeConfig[field])]);
    } else {
      unset.push(field);
    }
  }

  if (setEntries.length === 0 && unset.length === 0) return null;
  return {
    version: 1,
    set: Object.fromEntries(setEntries),
    unset,
  };
}

function applySandboxCustomImageReplay(
  config: Record<string, unknown>,
  replay: SandboxCustomImageReplay,
): Record<string, unknown> {
  const next = structuredClone(config);
  for (const field of replay.unset) {
    delete next[field];
  }
  for (const [field, value] of Object.entries(replay.set)) {
    next[field] = structuredClone(value);
  }
  return next;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLeaseDriverKey(lease: Pick<EnvironmentLease, "metadata">, environment: Pick<Environment, "driver">): string {
  const leaseDriver = typeof lease.metadata?.driver === "string" ? lease.metadata.driver : null;
  return leaseDriver ?? environment.driver;
}

function toEnvironmentLeaseSnapshot(row: typeof environmentLeases.$inferSelect): EnvironmentLease {
  return {
    id: row.id,
    companyId: row.companyId,
    environmentId: row.environmentId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    status: row.status as EnvironmentLease["status"],
    leasePolicy: row.leasePolicy as EnvironmentLease["leasePolicy"],
    provider: row.provider ?? null,
    providerLeaseId: row.providerLeaseId ?? null,
    acquiredAt: row.acquiredAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt ?? null,
    releasedAt: row.releasedAt ?? null,
    failureReason: row.failureReason ?? null,
    cleanupStatus: row.cleanupStatus as EnvironmentLease["cleanupStatus"],
    reusableResourceOwner: row.reusableResourceOwner,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reusableRuntimeFingerprint(input: {
  provider: string;
  adapterType: string | null;
  config: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(stableStringify(input))
    .digest("hex");
}

function serializeLeaseFingerprint(
  fingerprint: EffectiveRunConfigFingerprint | null | undefined,
): Record<string, unknown> | null {
  if (!fingerprint) return null;
  return {
    version: fingerprint.version,
    category: fingerprint.category,
    algorithm: fingerprint.algorithm,
    fingerprint: fingerprint.fingerprint,
  };
}

function readLeaseFingerprint(value: unknown): string | null {
  return isRecord(value) ? readString(value.fingerprint) : null;
}

async function buildEnvironmentSecretMetadataForLeaseFingerprint(input: {
  db: Db;
  companyId: string;
  environment: Environment;
  resolvedSecretVersions: readonly ResolvedEnvironmentSecretVersion[];
}): Promise<EffectiveRunConfigSecretVersionMetadata[]> {
  const refs = await collectEnvironmentSecretRefs({
    db: input.db,
    environment: input.environment,
  });
  if (refs.length === 0) return [];

  const resolvedVersionsBySecretAndPath = new Map(
    input.resolvedSecretVersions.map((resolved) => [
      `${resolved.secretId}\0${resolved.configPath}`,
      resolved.version,
    ]),
  );
  const resolvedVersionForRef = (
    ref: Awaited<ReturnType<typeof collectEnvironmentSecretRefs>>[number],
    latestVersion: number | null,
  ) => resolvedVersionsBySecretAndPath.get(`${ref.secretId}\0${ref.configPath}`) ?? (
    ref.versionSelector === "latest" || ref.versionSelector === undefined
      ? latestVersion
      : ref.versionSelector
  );

  const secretIds = [...new Set(refs.map((ref) => ref.secretId))];
  const secretRows = await input.db
    .select()
    .from(companySecrets)
    .where(inArray(companySecrets.id, secretIds));
  const secretsById = new Map(
    secretRows
      .filter((secret) => secret.companyId === input.companyId)
      .map((secret) => [secret.id, secret]),
  );

  const versionRequests = refs.flatMap((ref) => {
    const secret = secretsById.get(ref.secretId);
    if (!secret) return [];
    const resolvedVersion = resolvedVersionForRef(ref, secret.latestVersion);
    return typeof resolvedVersion === "number"
      ? [{ secretId: secret.id, version: resolvedVersion }]
      : [];
  });
  const versionSecretIds = [...new Set(versionRequests.map((request) => request.secretId))];
  const versions = [...new Set(versionRequests.map((request) => request.version))];
  const versionRows = versionSecretIds.length > 0 && versions.length > 0
    ? await input.db
        .select()
        .from(companySecretVersions)
        .where(
          and(
            inArray(companySecretVersions.secretId, versionSecretIds),
            inArray(companySecretVersions.version, versions),
          ),
        )
    : [];
  const versionsBySecretAndNumber = new Map(
    versionRows.map((row) => [`${row.secretId}:${row.version}`, row]),
  );

  const metadata: EffectiveRunConfigSecretVersionMetadata[] = [];
  for (const ref of refs) {
    const secret = secretsById.get(ref.secretId);
    if (!secret) {
      const resolvedVersion = resolvedVersionsBySecretAndPath.get(
        `${ref.secretId}\0${ref.configPath}`,
      );
      metadata.push({
        configPath: ref.configPath,
        envKey: null,
        secretId: ref.secretId,
        version: resolvedVersion ?? (
          typeof ref.versionSelector === "number" ? ref.versionSelector : "unresolved"
        ),
        outcome: "failure",
      });
      continue;
    }

    const resolvedVersion = resolvedVersionForRef(ref, secret.latestVersion);
    const versionRow = typeof resolvedVersion === "number"
      ? versionsBySecretAndNumber.get(`${secret.id}:${resolvedVersion}`) ?? null
      : null;

    metadata.push({
      configPath: ref.configPath,
      envKey: null,
      secretId: secret.id,
      version: resolvedVersion ?? "unresolved",
      provider: secret.provider,
      providerVersionRef: versionRow?.providerVersionRef ?? null,
      outcome: versionRow ? "success" : "failure",
    });
  }

  return metadata;
}

async function buildReusableSandboxLeaseFingerprint(input: {
  db: Db;
  companyId: string;
  environment: Environment;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  providerConfig: Record<string, unknown>;
  resolvedSecretVersions: readonly ResolvedEnvironmentSecretVersion[];
  providerPlugin?: {
    id: string;
    pluginKey: string;
    packageName: string;
    version: string;
  } | null;
}): Promise<EffectiveRunConfigFingerprint> {
  const secretMetadata = await buildEnvironmentSecretMetadataForLeaseFingerprint({
    db: input.db,
    companyId: input.companyId,
    environment: input.environment,
    resolvedSecretVersions: input.resolvedSecretVersions,
  });
  return createEffectiveRunConfigFingerprints({
    lease: {
      companyId: input.companyId,
      environment: {
        id: input.environment.id,
        driver: input.environment.driver,
      },
      executionWorkspaceId: input.executionWorkspaceId,
      agentId: input.agentId,
      adapterType: input.adapterType,
      provider: input.provider,
      providerPlugin: input.providerPlugin ?? null,
      providerConfig: input.providerConfig,
      secrets: secretMetadata,
    },
    secretManifest: secretMetadata,
  }).leaseFingerprint;
}

function buildReusableSandboxLeaseScope(input: {
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  config: Record<string, unknown>;
  leaseFingerprint?: EffectiveRunConfigFingerprint | null;
  providerMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  if (!input.executionWorkspaceId || !input.agentId) return null;
  const providerMetadata = input.providerMetadata ?? {};
  const adapterType = input.adapterType ?? null;
  const remoteCwd = readString(providerMetadata.remoteCwd);
  const workspaceSentinel = isRecord(providerMetadata.workspaceSentinel)
    ? { ...providerMetadata.workspaceSentinel }
    : null;
  return {
    version: 1,
    companyId: input.companyId,
    environmentId: input.environmentId,
    executionWorkspaceId: input.executionWorkspaceId,
    agentId: input.agentId,
    adapterType,
    provider: input.provider,
    runtimeFingerprint: reusableRuntimeFingerprint({
      provider: input.provider,
      adapterType,
      config: input.config,
    }),
    ...(input.leaseFingerprint
      ? { leaseFingerprint: serializeLeaseFingerprint(input.leaseFingerprint) }
      : {}),
    ...(remoteCwd ? { remoteCwd } : {}),
    ...(workspaceSentinel ? { workspaceSentinel } : {}),
  };
}

function reusableSandboxLeaseScopeMatches(input: {
  lease: Pick<EnvironmentLease, "metadata">;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  config: Record<string, unknown>;
  leaseFingerprint?: EffectiveRunConfigFingerprint | null;
  allowLegacyRuntimeFingerprint?: boolean;
}): boolean {
  if (!input.executionWorkspaceId || !input.agentId) return false;
  const scope = input.lease.metadata?.reusableSandboxLease;
  if (!isRecord(scope)) return false;
  const adapterType = input.adapterType ?? null;
  const baseScopeMatches =
    scope.companyId === input.companyId &&
    scope.environmentId === input.environmentId &&
    scope.executionWorkspaceId === input.executionWorkspaceId &&
    scope.agentId === input.agentId &&
    scope.adapterType === adapterType &&
    scope.provider === input.provider;
  if (!baseScopeMatches) return false;

  const expectedLeaseFingerprint = input.leaseFingerprint?.fingerprint ?? null;
  if (expectedLeaseFingerprint) {
    const storedLeaseFingerprint = readLeaseFingerprint(scope.leaseFingerprint);
    if (storedLeaseFingerprint) {
      return storedLeaseFingerprint === expectedLeaseFingerprint;
    }
    if (!input.allowLegacyRuntimeFingerprint) return false;
  }

  return scope.runtimeFingerprint === reusableRuntimeFingerprint({
    provider: input.provider,
    adapterType,
    config: input.config,
  });
}

function reusableLeaseCanBeResumed(input: {
  lease: Pick<EnvironmentLease, "status" | "heartbeatRunId" | "metadata" | "reusableResourceOwner">;
  heartbeatRunId: string | null;
}): boolean {
  if (!input.lease.reusableResourceOwner) return false;
  if (input.lease.metadata?.[PENDING_CLEANUP_RELEASE_STATUS_KEY] === "expired") return false;
  if (input.lease.status === "released" || input.lease.status === "retained") return true;
  return input.lease.status === "active" && input.heartbeatRunId !== null && input.lease.heartbeatRunId === input.heartbeatRunId;
}

function reusableLeaseCanBeCleanedUp(lease: Pick<EnvironmentLease, "status">): boolean {
  return lease.status === "released" || lease.status === "retained";
}

export function findReusableSandboxLeaseId(input: {
  config: SandboxEnvironmentConfig;
  leases: Array<Pick<EnvironmentLease, "providerLeaseId" | "metadata">>;
}): string | null {
  return findReusableSandboxProviderLeaseId(input);
}

function createLocalEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "local",

    async acquireRunLease(input) {
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "local",
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
        },
      });
    },

    async releaseRunLease(input) {
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd: input.workspace.localPath ?? input.workspace.remotePath ?? null,
        credentialOwnerAgentId: resolveRealizationCredentialOwnerAgentId(input),
      });
      return {
        cwd: input.workspace.localPath ?? input.workspace.remotePath ?? "/",
        metadata: {
          workspaceRealization: record,
        },
      };
    },
  };
}

function createSshEnvironmentDriver(db: Db): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);

  return {
    driver: "ssh",

    async acquireRunLease(input) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
      });
      if (parsed.driver !== "ssh") {
        throw new Error(`Expected SSH environment config for driver "${input.environment.driver}".`);
      }

      const { remoteCwd } = await ensureSshWorkspaceReady(parsed.config);
      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "ssh",
        providerLeaseId: `ssh://${parsed.config.username}@${parsed.config.host}:${parsed.config.port}${remoteCwd}`,
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          host: parsed.config.host,
          port: parsed.config.port,
          username: parsed.config.username,
          remoteWorkspacePath: parsed.config.remoteWorkspacePath,
          remoteCwd,
        },
      });
    },

    async releaseRunLease(input) {
      return await environmentsSvc.releaseLease(input.lease.id, input.status);
    },

    async realizeWorkspace(input) {
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd:
          typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
            ? input.lease.metadata.remoteCwd.trim()
            : input.workspace.remotePath ?? input.workspace.localPath ?? null,
        credentialOwnerAgentId: resolveRealizationCredentialOwnerAgentId(input),
      });
      return {
        cwd: record.remote.path ?? record.local.path,
        metadata: {
          workspaceRealization: record,
        },
      };
    },
  };
}

async function releaseEnvironmentLeaseAndDeleteBindings(input: {
  db: Db;
  lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
  failureReason?: string;
  cleanupClaimId?: string;
  clearReusableResourceOwner?: boolean;
  transactionDb?: Db;
}): Promise<EnvironmentLease | null> {
  const release = async (txDb: Db) => {
    const released = await environmentService(txDb).releaseLease(input.lease.id, input.status, {
      failureReason: input.failureReason,
      cleanupStatus: "success",
      expectedCleanupClaimId: input.cleanupClaimId,
      expectedStatus: input.cleanupClaimId ? "pending_cleanup" : input.lease.status,
      clearReusableResourceOwner: input.clearReusableResourceOwner,
    });
    if (!released) return null;
    await txDb
      .delete(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, input.lease.companyId),
        eq(companySecretBindings.targetType, "environment_lease"),
        eq(companySecretBindings.targetId, input.lease.id),
      ));
    return released;
  };
  return input.transactionDb
    ? await release(input.transactionDb)
    : await input.db.transaction(async (tx) => await release(tx as unknown as Db));
}

function createSandboxEnvironmentDriver(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    pluginWorkerReadyTimeoutMs?: number;
    pluginWorkerReadyPollMs?: number;
    claimPendingCleanup: (input: { leaseId: string; updatedBefore?: Date }) => Promise<{
      claimId: string;
      row: typeof environmentLeases.$inferSelect;
    } | null>;
    renewPendingCleanupClaim: (leaseId: string, claimId: string) => ReturnType<typeof setInterval>;
    deferCleanupClaim: (
      claim: { claimId: string; row: typeof environmentLeases.$inferSelect },
      failureReason: string,
    ) => Promise<EnvironmentLease | null>;
  },
): EnvironmentRuntimeDriver {
  const pluginWorkerManager = options.pluginWorkerManager;
  const pluginWorkerReadyTimeoutMs = options.pluginWorkerReadyTimeoutMs ?? DEFAULT_PLUGIN_SANDBOX_WORKER_READY_TIMEOUT_MS;
  const pluginWorkerReadyPollMs = options.pluginWorkerReadyPollMs ?? DEFAULT_PLUGIN_SANDBOX_WORKER_READY_POLL_MS;
  const environmentsSvc = environmentService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const runtimeConfigByLeaseId = new Map<string, {
    provider: string;
    promise: Promise<Record<string, unknown>>;
    expiresAt: number;
  }>();

  function clearSandboxRuntimeConfig(leaseId: string) {
    runtimeConfigByLeaseId.delete(leaseId);
  }

  function pruneExpiredSandboxRuntimeConfig(now: number) {
    for (const [leaseId, entry] of runtimeConfigByLeaseId) {
      if (entry.expiresAt <= now) runtimeConfigByLeaseId.delete(leaseId);
    }
    while (runtimeConfigByLeaseId.size > SANDBOX_RUNTIME_CONFIG_CACHE_MAX_ENTRIES) {
      const oldest = runtimeConfigByLeaseId.keys().next().value;
      if (oldest === undefined) break;
      runtimeConfigByLeaseId.delete(oldest);
    }
  }

  function secretBindingTargetForLease(lease: EnvironmentLease) {
    return lease.metadata?.[LEASE_SCOPED_SECRET_BINDINGS_KEY] === true
      ? { targetType: "environment_lease" as const, targetId: lease.id }
      : undefined;
  }

  function parseSandboxSecretVersionSelector(value: string, configPath: string): number | "latest" {
    if (value === "latest") return value;
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error(`Sandbox secret binding changed while acquiring lease at "${configPath}".`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Sandbox secret binding changed while acquiring lease at "${configPath}".`);
    }
    return parsed;
  }

  async function validateSandboxSecretVersions(input: {
    txDb: Db;
    companyId: string;
    bindings: Array<{
      secretId: string;
      version: number;
      configPath: string;
      projectionClass: string | null;
      projectionAllowlistKey: string | null;
    }>;
  }): Promise<void> {
    if (input.bindings.length === 0) return;

    const secretIds = [...new Set(input.bindings.map((binding) => binding.secretId))];
    const secrets = await input.txDb
      .select({ id: companySecrets.id, status: companySecrets.status })
      .from(companySecrets)
      .where(and(
        eq(companySecrets.companyId, input.companyId),
        inArray(companySecrets.id, secretIds),
      ));
    const activeSecretIds = new Set(
      secrets.filter((secret) => secret.status === "active").map((secret) => secret.id),
    );
    const versionNumbers = [...new Set(input.bindings.map((binding) => binding.version))];
    const versions = await input.txDb
      .select({
        secretId: companySecretVersions.secretId,
        version: companySecretVersions.version,
        status: companySecretVersions.status,
        revokedAt: companySecretVersions.revokedAt,
      })
      .from(companySecretVersions)
      .where(and(
        inArray(companySecretVersions.secretId, secretIds),
        inArray(companySecretVersions.version, versionNumbers),
      ));
    const activeVersions = new Set(
      versions
        .filter((version) =>
          version.status !== "disabled" && version.status !== "destroyed" && !version.revokedAt
        )
        .map((version) => `${version.secretId}:${version.version}`),
    );

    for (const binding of input.bindings) {
      assertClass3StaticLeaseAllowed({
        targetType: "environment",
        configPath: binding.configPath,
        projectionClass: binding.projectionClass,
        projectionAllowlistKey: binding.projectionAllowlistKey,
      });
      if (
        !activeSecretIds.has(binding.secretId) ||
        !activeVersions.has(`${binding.secretId}:${binding.version}`)
      ) {
        throw new Error(
          `Sandbox secret binding changed while acquiring lease at "${binding.configPath}".`,
        );
      }
    }
  }

  async function copyEnvironmentSecretBindingsToLease(input: {
    txDb: Db;
    companyId: string;
    environmentId: string;
    leaseId: string;
    secretRefs: Awaited<ReturnType<typeof collectEnvironmentSecretRefs>>;
    resolvedSecretVersions: ResolvedEnvironmentSecretVersion[];
  }): Promise<void> {
    if (input.secretRefs.length === 0 && input.resolvedSecretVersions.length === 0) return;

    const resolvedVersionsByPath = new Map(
      input.resolvedSecretVersions.map((resolved) => [resolved.configPath, resolved]),
    );
    const runtimeSecretRefs = input.secretRefs.filter((ref) =>
      resolvedVersionsByPath.has(ref.configPath),
    );
    if (
      resolvedVersionsByPath.size !== input.resolvedSecretVersions.length ||
      runtimeSecretRefs.length !== input.resolvedSecretVersions.length
    ) {
      throw new Error("Sandbox secret resolution changed while acquiring lease.");
    }

    const bindings = await input.txDb
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, input.companyId),
        eq(companySecretBindings.targetType, "environment"),
        eq(companySecretBindings.targetId, input.environmentId),
        inArray(companySecretBindings.configPath, runtimeSecretRefs.map((ref) => ref.configPath)),
      ));
    const bindingsByPath = new Map(bindings.map((binding) => [binding.configPath, binding]));
    const bindingsToValidate: Parameters<typeof validateSandboxSecretVersions>[0]["bindings"] = [];
    const leaseBindings: Array<typeof companySecretBindings.$inferInsert> = [];
    for (const ref of runtimeSecretRefs) {
      const binding = bindingsByPath.get(ref.configPath);
      const resolved = resolvedVersionsByPath.get(ref.configPath);
      if (
        !binding ||
        !resolved ||
        binding.secretId !== ref.secretId ||
        resolved.secretId !== ref.secretId ||
        binding.id !== resolved.bindingId ||
        binding.versionSelector !== resolved.versionSelector
      ) {
        throw new Error(`Sandbox secret binding changed while acquiring lease at "${ref.configPath}".`);
      }
      bindingsToValidate.push({
        secretId: binding.secretId,
        version: resolved.version,
        configPath: binding.configPath,
        projectionClass: binding.projectionClass,
        projectionAllowlistKey: binding.projectionAllowlistKey,
      });
      leaseBindings.push({
        companyId: binding.companyId,
        secretId: binding.secretId,
        targetType: "environment_lease" as const,
        targetId: input.leaseId,
        configPath: binding.configPath,
        versionSelector: String(resolved.version),
        required: binding.required,
        label: binding.label,
        projectionClass: binding.projectionClass,
        projectionAllowlistKey: binding.projectionAllowlistKey,
      });
    }
    await validateSandboxSecretVersions({
      txDb: input.txDb,
      companyId: input.companyId,
      bindings: bindingsToValidate,
    });
    await input.txDb.insert(companySecretBindings).values(leaseBindings);
  }

  async function copyLeaseSecretBindings(input: {
    txDb: Db;
    companyId: string;
    sourceLeaseId: string;
    targetLeaseId: string;
  }): Promise<void> {
    const bindings = await input.txDb
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, input.companyId),
        eq(companySecretBindings.targetType, "environment_lease"),
        eq(companySecretBindings.targetId, input.sourceLeaseId),
      ));
    if (bindings.length === 0) return;

    await input.txDb.insert(companySecretBindings).values(bindings.map((binding) => ({
      companyId: binding.companyId,
      secretId: binding.secretId,
      targetType: "environment_lease",
      targetId: input.targetLeaseId,
      configPath: binding.configPath,
      versionSelector: binding.versionSelector,
      required: binding.required,
      label: binding.label,
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey,
    })));
  }

  async function validateEnvironmentSecretBindingsAgainstLease(input: {
    txDb: Db;
    companyId: string;
    environmentId: string;
    leaseId: string;
    resolvedSecretVersions: ResolvedEnvironmentSecretVersion[];
  }): Promise<void> {
    const leaseBindings = await input.txDb
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, input.companyId),
        eq(companySecretBindings.targetType, "environment_lease"),
        eq(companySecretBindings.targetId, input.leaseId),
      ));
    if (leaseBindings.length === 0 && input.resolvedSecretVersions.length === 0) return;

    const leaseBindingsByPath = new Map(
      leaseBindings.map((binding) => [binding.configPath, binding]),
    );
    const resolvedVersionsByPath = new Map(
      input.resolvedSecretVersions.map((resolved) => [resolved.configPath, resolved]),
    );
    if (
      leaseBindingsByPath.size !== leaseBindings.length ||
      resolvedVersionsByPath.size !== input.resolvedSecretVersions.length ||
      leaseBindings.length !== input.resolvedSecretVersions.length
    ) {
      throw new Error("Sandbox secret resolution changed while acquiring lease.");
    }

    const environmentBindings = await input.txDb
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, input.companyId),
        eq(companySecretBindings.targetType, "environment"),
        eq(companySecretBindings.targetId, input.environmentId),
        inArray(
          companySecretBindings.configPath,
          input.resolvedSecretVersions.map((resolved) => resolved.configPath),
        ),
      ));
    const environmentBindingsByPath = new Map(
      environmentBindings.map((binding) => [binding.configPath, binding]),
    );
    const bindingsToValidate: Parameters<typeof validateSandboxSecretVersions>[0]["bindings"] = [];
    for (const resolved of input.resolvedSecretVersions) {
      const leaseBinding = leaseBindingsByPath.get(resolved.configPath);
      const environmentBinding = environmentBindingsByPath.get(resolved.configPath);
      if (
        !leaseBinding ||
        !environmentBinding ||
        environmentBinding.id !== resolved.bindingId ||
        environmentBinding.secretId !== resolved.secretId ||
        environmentBinding.versionSelector !== resolved.versionSelector ||
        environmentBinding.secretId !== leaseBinding.secretId ||
        environmentBinding.required !== leaseBinding.required ||
        environmentBinding.label !== leaseBinding.label ||
        environmentBinding.projectionClass !== leaseBinding.projectionClass ||
        environmentBinding.projectionAllowlistKey !== leaseBinding.projectionAllowlistKey
      ) {
        throw new Error(
          `Sandbox secret binding changed while acquiring lease at "${resolved.configPath}".`,
        );
      }
      const frozenLeaseVersion = parseSandboxSecretVersionSelector(
        leaseBinding.versionSelector,
        leaseBinding.configPath,
      );
      if (
        frozenLeaseVersion === "latest" ||
        frozenLeaseVersion !== resolved.version
      ) {
        throw new Error(
          `Sandbox secret binding changed while acquiring lease at "${leaseBinding.configPath}".`,
        );
      }
      bindingsToValidate.push({
        secretId: environmentBinding.secretId,
        version: resolved.version,
        configPath: environmentBinding.configPath,
        projectionClass: environmentBinding.projectionClass,
        projectionAllowlistKey: environmentBinding.projectionAllowlistKey,
      });
    }
    await validateSandboxSecretVersions({
      txDb: input.txDb,
      companyId: input.companyId,
      bindings: bindingsToValidate,
    });
  }

  async function acquireSandboxLease(
    environment: Environment,
    input: Parameters<typeof environmentsSvc.acquireLease>[0],
    reservation: EnvironmentLease,
    resolvedSecretVersions: ResolvedEnvironmentSecretVersion[],
    supersededLease?: EnvironmentLease | null,
    adoptionClaimId?: string | null,
  ): Promise<EnvironmentLease> {
    const leaseId = reservation.id;

    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await validateEnvironmentSecretBindingsAgainstLease({
        txDb,
        companyId: input.companyId,
        environmentId: environment.id,
        leaseId,
        resolvedSecretVersions,
      });
      const leaseMetadata = {
        ...(input.metadata ?? {}),
        [LEASE_SCOPED_SECRET_BINDINGS_KEY]: true,
      };
      if (supersededLease) {
        if (!adoptionClaimId || !supersededLease.providerLeaseId) {
          throw new Error(`Reusable sandbox lease "${supersededLease.id}" has no adoption claim.`);
        }
        const releasedOwner = await txDb
          .update(environmentLeases)
          .set({
            reusableResourceOwner: false,
            reusableAdoptionClaimId: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(environmentLeases.id, supersededLease.id),
            eq(environmentLeases.companyId, supersededLease.companyId),
            eq(environmentLeases.environmentId, supersededLease.environmentId),
            eq(environmentLeases.provider, supersededLease.provider!),
            eq(environmentLeases.providerLeaseId, supersededLease.providerLeaseId),
            eq(environmentLeases.status, supersededLease.status),
            eq(environmentLeases.reusableResourceOwner, true),
            eq(environmentLeases.reusableAdoptionClaimId, adoptionClaimId),
            isNull(environmentLeases.cleanupClaimId),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!releasedOwner) {
          throw new Error(`Reusable sandbox lease "${supersededLease.id}" changed during handoff.`);
        }
        const retired = await releaseLeaseAndDeleteBindings({
          lease: toEnvironmentLeaseSnapshot(releasedOwner),
          status: "expired",
        }, txDb);
        if (!retired) {
          throw new Error(`Reusable sandbox lease "${supersededLease.id}" changed during handoff.`);
        }
      }
      const reusableResourceOwner =
        (input.leasePolicy ?? "ephemeral") === "reuse_by_environment"
        && Boolean(input.provider)
        && Boolean(input.providerLeaseId);
      const lease = await txDb
        .update(environmentLeases)
        .set({
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          issueId: input.issueId ?? null,
          heartbeatRunId: input.heartbeatRunId ?? null,
          status: "active",
          leasePolicy: input.leasePolicy ?? "ephemeral",
          provider: input.provider ?? null,
          providerLeaseId: input.providerLeaseId ?? null,
          expiresAt: input.expiresAt ?? null,
          releasedAt: null,
          failureReason: null,
          cleanupStatus: null,
          cleanupClaimId: null,
          cleanupClaimedAt: null,
          reusableResourceOwner,
          reusableAdoptionClaimId: null,
          metadata: leaseMetadata,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(environmentLeases.id, reservation.id),
          eq(environmentLeases.status, "active"),
          isNull(environmentLeases.providerLeaseId),
        ))
        .returning()
        .then((rows) => rows[0] ? toEnvironmentLeaseSnapshot(rows[0]) : null);
      if (!lease) {
        throw new Error(`Sandbox lease reservation "${leaseId}" changed during acquisition.`);
      }
      return lease;
    });
  }

  async function reserveSandboxLease(
    input: EnvironmentDriverAcquireInput,
    reservation: {
      id: string;
      provider: string;
      leasePolicy: EnvironmentLease["leasePolicy"];
      metadata: Record<string, unknown>;
    },
    resolvedSecretVersions: ResolvedEnvironmentSecretVersion[],
  ): Promise<EnvironmentLease> {
    const secretRefs = await collectEnvironmentSecretRefs({ db, environment: input.environment });
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const lease = await environmentService(txDb).acquireLease({
        id: reservation.id,
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: reservation.leasePolicy,
        provider: reservation.provider,
        metadata: {
          ...reservation.metadata,
          [LEASE_SCOPED_SECRET_BINDINGS_KEY]: true,
          [SANDBOX_ACQUISITION_ID_KEY]: reservation.id,
          [SANDBOX_LEASE_RESERVATION_KEY]: true,
        },
      });
      await copyEnvironmentSecretBindingsToLease({
        txDb,
        companyId: input.companyId,
        environmentId: input.environment.id,
        leaseId: reservation.id,
        secretRefs,
        resolvedSecretVersions,
      });
      return lease;
    });
  }

  async function abandonSandboxLeaseReservation(
    reservation: EnvironmentLease,
    failureReason: string,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const txEnvironmentsSvc = environmentService(txDb);
      const options = {
        failureReason,
        cleanupStatus: "success" as const,
        expectedStatus: "active" as const,
      };
      const abandoned = await txEnvironmentsSvc.releaseLease(reservation.id, "failed", options) ??
        await txEnvironmentsSvc.releaseLease(reservation.id, "failed", {
          ...options,
          expectedStatus: "pending_cleanup",
        });
      if (!abandoned) return;
      await txDb
        .delete(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, reservation.companyId),
          eq(companySecretBindings.targetType, "environment_lease"),
          eq(companySecretBindings.targetId, reservation.id),
        ));
    });
  }

  async function deferSandboxLeaseReservation(
    reservation: EnvironmentLease,
    targetStatus: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">,
    failureReason: string,
  ): Promise<EnvironmentLease | null> {
    const now = new Date();
    const deferred = await db
      .update(environmentLeases)
      .set({
        status: "pending_cleanup",
        releasedAt: now,
        lastUsedAt: now,
        updatedAt: now,
        failureReason,
        cleanupStatus: "failed",
        cleanupClaimId: null,
        cleanupClaimedAt: null,
        metadata: sql<Record<string, unknown>>`
          coalesce(${environmentLeases.metadata}, '{}'::jsonb)
          || ${JSON.stringify({
            [PENDING_CLEANUP_RELEASE_STATUS_KEY]: targetStatus,
          })}::jsonb
        `,
      })
      .where(and(
        eq(environmentLeases.id, reservation.id),
        eq(environmentLeases.status, "active"),
        isNull(environmentLeases.providerLeaseId),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (deferred) return toEnvironmentLeaseSnapshot(deferred);

    return await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, reservation.id))
      .then((rows) => rows[0] ? toEnvironmentLeaseSnapshot(rows[0]) : null);
  }

  async function clearReusableSandboxAcquisitionContext(input: {
    reservation: EnvironmentLease;
    acquisitionContext: SandboxAcquisitionContext;
  }): Promise<SandboxAcquisitionContext> {
    const reusableProviderLeaseId = input.acquisitionContext.reusableProviderLeaseId;
    if (!reusableProviderLeaseId) return input.acquisitionContext;

    const clearedContext: SandboxAcquisitionContext = {
      ...input.acquisitionContext,
      reusableProviderLeaseId: null,
    };
    const row = await db
      .update(environmentLeases)
      .set({
        metadata: {
          ...(input.reservation.metadata ?? {}),
          [SANDBOX_ACQUISITION_CONTEXT_KEY]: clearedContext,
        },
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(environmentLeases.id, input.reservation.id),
        eq(environmentLeases.status, "active"),
        isNull(environmentLeases.providerLeaseId),
        sql`${environmentLeases.metadata} -> ${SANDBOX_ACQUISITION_CONTEXT_KEY} ->> 'reusableProviderLeaseId' = ${reusableProviderLeaseId}`,
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) {
      throw new Error(
        `Sandbox lease reservation "${input.reservation.id}" changed before fallback acquisition.`,
      );
    }
    return clearedContext;
  }

  async function claimReusableSandboxLeaseForAdoption(
    lease: EnvironmentLease,
    adoptionClaimId: string,
  ): Promise<EnvironmentLease | null> {
    if (!lease.provider || !lease.providerLeaseId) return null;
    const row = await db
      .update(environmentLeases)
      .set({
        reusableAdoptionClaimId: adoptionClaimId,
        updatedAt: new Date(),
      })
      .where(and(
        eq(environmentLeases.id, lease.id),
        eq(environmentLeases.companyId, lease.companyId),
        eq(environmentLeases.environmentId, lease.environmentId),
        eq(environmentLeases.provider, lease.provider),
        eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
        eq(environmentLeases.status, lease.status),
        eq(environmentLeases.reusableResourceOwner, true),
        isNull(environmentLeases.reusableAdoptionClaimId),
        isNull(environmentLeases.cleanupClaimId),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? toEnvironmentLeaseSnapshot(row) : null;
  }

  async function clearReusableSandboxAdoptionClaim(
    lease: EnvironmentLease,
    adoptionClaimId: string,
  ): Promise<void> {
    if (!lease.provider || !lease.providerLeaseId) return;
    await db
      .update(environmentLeases)
      .set({
        reusableAdoptionClaimId: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(environmentLeases.id, lease.id),
        eq(environmentLeases.companyId, lease.companyId),
        eq(environmentLeases.environmentId, lease.environmentId),
        eq(environmentLeases.provider, lease.provider),
        eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
        eq(environmentLeases.reusableResourceOwner, true),
        eq(environmentLeases.reusableAdoptionClaimId, adoptionClaimId),
        isNull(environmentLeases.cleanupClaimId),
      ));
  }

  async function findReusableSandboxResourceOwner(input: {
    companyId: string;
    environmentId: string;
    provider: string | null | undefined;
    providerLeaseId: string | null | undefined;
    excludeLeaseId?: string;
  }): Promise<{ id: string } | null> {
    if (!input.provider || !input.providerLeaseId) return null;
    return await db
      .select({ id: environmentLeases.id })
      .from(environmentLeases)
      .where(and(
        eq(environmentLeases.companyId, input.companyId),
        eq(environmentLeases.environmentId, input.environmentId),
        eq(environmentLeases.provider, input.provider),
        eq(environmentLeases.providerLeaseId, input.providerLeaseId),
        eq(environmentLeases.reusableResourceOwner, true),
        input.excludeLeaseId
          ? ne(environmentLeases.id, input.excludeLeaseId)
          : undefined,
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function findOtherReusableSandboxResourceOwner(
    input: Parameters<typeof environmentsSvc.acquireLease>[0],
    reservationId: string,
  ): Promise<{ id: string } | null> {
    if (input.leasePolicy !== "reuse_by_environment") return null;
    return await findReusableSandboxResourceOwner({
      companyId: input.companyId,
      environmentId: input.environmentId,
      provider: input.provider,
      providerLeaseId: input.providerLeaseId,
      excludeLeaseId: reservationId,
    });
  }

  async function terminalizeSandboxRecoveryReservationForExistingOwner(input: {
    lease: EnvironmentLease;
    cleanupClaimId: string;
  }): Promise<EnvironmentLease> {
    const terminal = await releaseLeaseAndDeleteBindings({
      lease: input.lease,
      status: "failed",
      failureReason: "provider_lease_already_owned",
      cleanupClaimId: input.cleanupClaimId,
    });
    if (!terminal) {
      throw new Error(
        `Sandbox lease reservation "${input.lease.id}" changed before owner-conflict terminalization.`,
      );
    }
    return terminal;
  }

  async function destroyReusableSandboxLeaseAfterFailedResume(input: {
    environment: Environment;
    lease: EnvironmentLease;
    adoptionClaimId: string;
  }): Promise<EnvironmentLease | null> {
    const claimed = await claimReusableSandboxLeaseForCleanup(
      input.lease,
      input.adoptionClaimId,
    );
    if (!claimed) return null;
    return await destroyReusableSandboxLease({
      environment: input.environment,
      lease: claimed.lease,
      failureReason: "resume_failed",
      cleanupClaimId: claimed.cleanupClaimId,
    });
  }

  async function persistSandboxLeaseCleanup(
    reservation: EnvironmentLease,
    input: Parameters<typeof environmentsSvc.acquireLease>[0],
  ): Promise<EnvironmentLease | null> {
    const now = new Date();
    const cleanupValues = {
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      issueId: input.issueId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      status: "pending_cleanup" as const,
      leasePolicy: input.leasePolicy ?? "ephemeral",
      provider: input.provider ?? null,
      providerLeaseId: input.providerLeaseId ?? null,
      expiresAt: input.expiresAt ?? null,
      releasedAt: now,
      failureReason: "acquire_handoff_failed",
      cleanupStatus: "failed" as const,
      reusableResourceOwner:
        (input.leasePolicy ?? "ephemeral") === "reuse_by_environment"
        && Boolean(input.provider)
        && Boolean(input.providerLeaseId),
      reusableAdoptionClaimId: null,
      metadata: sql<Record<string, unknown>>`
        ${JSON.stringify({
          ...(input.metadata ?? {}),
          [LEASE_SCOPED_SECRET_BINDINGS_KEY]: true,
        })}::jsonb
        || jsonb_build_object(
          'pendingCleanupReleaseStatus',
          coalesce(
            ${environmentLeases.metadata} -> 'pendingCleanupReleaseStatus',
            '"expired"'::jsonb
          )
        )
      `,
      lastUsedAt: now,
      updatedAt: now,
    };
    const row = await db
      .update(environmentLeases)
      .set(cleanupValues)
      .where(and(
        eq(environmentLeases.id, reservation.id),
        inArray(environmentLeases.status, ["active", "pending_cleanup"]),
        isNull(environmentLeases.providerLeaseId),
        isNull(environmentLeases.cleanupClaimId),
        isNull(environmentLeases.cleanupClaimedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (row) return toEnvironmentLeaseSnapshot(row);

    if (input.providerLeaseId) {
      const claimedRow = await db
        .update(environmentLeases)
        .set(cleanupValues)
        .where(and(
          eq(environmentLeases.id, reservation.id),
          eq(environmentLeases.status, "pending_cleanup"),
          isNull(environmentLeases.providerLeaseId),
          or(
            isNotNull(environmentLeases.cleanupClaimId),
            isNotNull(environmentLeases.cleanupClaimedAt),
          ),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (claimedRow) return toEnvironmentLeaseSnapshot(claimedRow);
    }

    const current = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, reservation.id))
      .then((rows) => rows[0] ?? null);
    if (input.providerLeaseId && current?.providerLeaseId === input.providerLeaseId) return null;
    throw new Error(`Sandbox lease reservation "${reservation.id}" changed before cleanup handoff.`);
  }

  async function persistStandaloneSandboxLeaseCleanup(
    sourceLease: EnvironmentLease,
    input: Parameters<typeof environmentsSvc.acquireLease>[0],
  ): Promise<EnvironmentLease> {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const txEnvironmentsSvc = environmentService(txDb);
      const cleanupId = randomUUID();
      await txEnvironmentsSvc.acquireLease({
        ...input,
        id: cleanupId,
        reusableResourceOwner:
          input.leasePolicy === "reuse_by_environment"
          && Boolean(input.provider)
          && Boolean(input.providerLeaseId),
      });
      await copyLeaseSecretBindings({
        txDb,
        companyId: sourceLease.companyId,
        sourceLeaseId: sourceLease.id,
        targetLeaseId: cleanupId,
      });
      const cleanupLease = await txEnvironmentsSvc.releaseLease(cleanupId, "pending_cleanup", {
        failureReason: "acquire_handoff_failed",
        cleanupStatus: "failed",
        expectedStatus: "active",
        metadata: {
          ...(input.metadata ?? {}),
          [LEASE_SCOPED_SECRET_BINDINGS_KEY]: true,
          [PENDING_CLEANUP_RELEASE_STATUS_KEY]: "expired",
        },
      });
      if (!cleanupLease) {
        throw new Error(`Sandbox cleanup lease "${cleanupId}" changed during creation.`);
      }
      return cleanupLease;
    });
  }

  async function cleanupPersistedSandboxLease(
    environment: Environment,
    cleanupLease: EnvironmentLease,
    failureReason: string,
  ): Promise<void> {
    const claim = await options.claimPendingCleanup({ leaseId: cleanupLease.id });
    if (!claim) return;
    const claimedLease = toEnvironmentLeaseSnapshot(claim.row);
    const claimRenewal = options.renewPendingCleanupClaim(claimedLease.id, claim.claimId);
    try {
      const cleanupEnvironment = await environmentsSvc.getById(environment.id) ?? environment;
      if (claimedLease.leasePolicy === "reuse_by_environment") {
        await destroyReusableSandboxLease({
          environment: cleanupEnvironment,
          lease: claimedLease,
          failureReason,
          cleanupClaimId: claim.claimId,
        });
        return;
      }

      const pendingTarget = claimedLease.metadata?.[PENDING_CLEANUP_RELEASE_STATUS_KEY];
      const releaseStatus = pendingTarget === "released" || pendingTarget === "failed"
        ? pendingTarget
        : "expired";
      const release: EnvironmentDriverReleaseInput = {
        environment: cleanupEnvironment,
        lease: claimedLease,
        status: releaseStatus,
        cleanupClaimId: claim.claimId,
      };
      const metadataConfig = sandboxConfigFromLeaseMetadata(claimedLease);
      const looseConfig = metadataConfig ? null : sandboxConfigFromLeaseMetadataLoose(claimedLease);
      if (
        claimedLease.metadata?.sandboxProviderPlugin ||
        (looseConfig && !isBuiltinSandboxProvider(looseConfig.provider))
      ) {
        await releasePluginBackedSandboxLease(release, failureReason);
        return;
      }

      let cleanupError: unknown | null = null;
      try {
        const providerKey = readString(claimedLease.metadata?.provider) ?? metadataConfig?.provider;
        if (!providerKey) throw new Error(`Sandbox lease "${claimedLease.id}" has no provider.`);
        const config = await resolveSandboxRuntimeConfig({
          environment: cleanupEnvironment,
          lease: claimedLease,
          provider: providerKey,
        });
        await releaseSandboxProviderLease({
          config: config as unknown as SandboxEnvironmentConfig,
          providerLeaseId: claimedLease.providerLeaseId,
          status: releaseStatus,
        });
      } catch (error) {
        cleanupError = error;
      }
      await finalizeSandboxRelease({
        release,
        cleanupError,
        failureReason,
      });
    } catch (error) {
      await options.deferCleanupClaim(claim, failureReason);
      throw error;
    } finally {
      clearInterval(claimRenewal);
    }
  }

  async function compensateFailedSandboxLeaseAcquisition(
    environment: Environment,
    input: Parameters<typeof environmentsSvc.acquireLease>[0],
    reservation: EnvironmentLease,
    cleanupUnrecordedLease: () => Promise<void>,
  ) {
    if (await findOtherReusableSandboxResourceOwner(input, reservation.id)) {
      await abandonSandboxLeaseReservation(reservation, "provider_lease_already_owned");
      return;
    }
    let cleanupLease: EnvironmentLease | null = null;
    try {
      cleanupLease = await persistSandboxLeaseCleanup(reservation, input);
      if (!cleanupLease) return;
      await cleanupPersistedSandboxLease(environment, cleanupLease, "acquire_handoff_failed");
    } catch (cleanupError) {
      if (!cleanupLease) {
        if (await findOtherReusableSandboxResourceOwner(input, reservation.id)) {
          await abandonSandboxLeaseReservation(reservation, "provider_lease_already_owned");
          return;
        }
        try {
          await cleanupUnrecordedLease();
          await abandonSandboxLeaseReservation(reservation, "acquire_handoff_failed");
          return;
        } catch (unrecordedCleanupError) {
          try {
            await persistStandaloneSandboxLeaseCleanup(reservation, input);
          } catch (standalonePersistenceError) {
            logger.error(
              {
                err: standalonePersistenceError,
                cleanupErr: unrecordedCleanupError,
                handoffErr: cleanupError,
                environmentId: environment.id,
                providerLeaseId: input.providerLeaseId,
              },
              "failed to persist sandbox cleanup after direct acquisition cleanup failure",
            );
          }
          return;
        }
      }
      logger.error(
        { err: cleanupError, environmentId: environment.id, providerLeaseId: input.providerLeaseId },
        "failed to compensate sandbox lease after acquisition handoff failure",
      );
    }
  }

  async function acquireSandboxLeaseWithCompensation(
    environment: Environment,
    input: Parameters<typeof environmentsSvc.acquireLease>[0],
    reservation: EnvironmentLease,
    resolvedSecretVersions: ResolvedEnvironmentSecretVersion[],
    supersededLease?: EnvironmentLease | null,
    adoptionClaimId?: string | null,
    cleanupUnrecordedLease?: () => Promise<void>,
  ) {
    try {
      return await acquireSandboxLease(
        environment,
        input,
        reservation,
        resolvedSecretVersions,
        supersededLease,
        adoptionClaimId,
      );
    } catch (error) {
      // A resumed provider lease remains represented by the superseded row
      // when the handoff transaction rolls back; only fresh leases need cleanup.
      if (!supersededLease) {
        const existingOwner = await findOtherReusableSandboxResourceOwner(input, reservation.id);
        if (existingOwner) {
          await abandonSandboxLeaseReservation(reservation, "provider_lease_already_owned");
          throw error;
        }
        await compensateFailedSandboxLeaseAcquisition(
          environment,
          input,
          reservation,
          cleanupUnrecordedLease ?? (async () => {
            throw new Error("No direct sandbox cleanup is available for the unrecorded lease.");
          }),
        );
      } else {
        if (adoptionClaimId) {
          await clearReusableSandboxAdoptionClaim(supersededLease, adoptionClaimId);
        }
        await abandonSandboxLeaseReservation(reservation, "acquire_handoff_failed");
      }
      throw error;
    }
  }

  async function releaseLeaseAndDeleteBindings(input: {
    lease: EnvironmentLease;
    status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
    failureReason?: string;
    cleanupClaimId?: string;
    clearReusableResourceOwner?: boolean;
  }, transactionDb?: Db): Promise<EnvironmentLease | null> {
    const released = await releaseEnvironmentLeaseAndDeleteBindings({
      db,
      ...input,
      transactionDb,
    });
    if (released) clearSandboxRuntimeConfig(input.lease.id);
    return released;
  }

  async function persistSandboxRelease(input: {
    release: EnvironmentDriverReleaseInput;
    cleanupError: unknown | null;
    deleteBindings?: boolean;
    failureReason?: string;
  }, transactionDb?: Db): Promise<EnvironmentLease | null> {
    const persistEnvironmentsSvc = environmentService(transactionDb ?? db);
    const releaseStatus =
      input.release.lease.leasePolicy === "retain_on_failure" && input.release.status === "failed"
        ? ("retained" as const)
        : input.release.status;

    if (input.cleanupError && input.release.lease.leasePolicy !== "retain_on_failure") {
      logger.warn(
        {
          err: input.cleanupError,
          leaseId: input.release.lease.id,
          environmentId: input.release.environment.id,
          provider: input.release.lease.provider,
        },
        "sandbox lease cleanup failed; queued for retry",
      );
      return await persistEnvironmentsSvc.releaseLease(input.release.lease.id, "pending_cleanup", {
        failureReason: input.failureReason ?? (input.release.status === "failed" ? "adapter_or_run_failure" : undefined),
        cleanupStatus: "failed",
        expectedCleanupClaimId: input.release.cleanupClaimId,
        expectedStatus: input.release.cleanupClaimId ? "pending_cleanup" : input.release.lease.status,
        metadata: {
          ...(input.release.lease.metadata ?? {}),
          ...verifiedCleanupMetadata(input.cleanupError, input.release.lease),
          [PENDING_CLEANUP_RELEASE_STATUS_KEY]: releaseStatus,
        },
      });
    }

    if (!input.cleanupError && (input.deleteBindings ?? input.release.lease.leasePolicy === "ephemeral")) {
      try {
        return await releaseLeaseAndDeleteBindings({
          lease: input.release.lease,
          status: releaseStatus as "released" | "expired" | "failed",
          failureReason: input.failureReason ?? (input.release.status === "failed" ? "adapter_or_run_failure" : undefined),
          cleanupClaimId: input.release.cleanupClaimId,
          clearReusableResourceOwner:
            input.release.lease.leasePolicy === "reuse_by_environment",
        }, transactionDb);
      } catch (error) {
        logger.warn(
          { err: error, leaseId: input.release.lease.id },
          "sandbox lease binding cleanup failed; queued for retry",
        );
        return await persistEnvironmentsSvc.releaseLease(input.release.lease.id, "pending_cleanup", {
          failureReason: input.failureReason ?? (input.release.status === "failed" ? "adapter_or_run_failure" : undefined),
          cleanupStatus: "failed",
          expectedCleanupClaimId: input.release.cleanupClaimId,
          expectedStatus: input.release.cleanupClaimId ? "pending_cleanup" : input.release.lease.status,
          metadata: {
            ...(input.release.lease.metadata ?? {}),
            [PENDING_CLEANUP_RELEASE_STATUS_KEY]: releaseStatus,
          },
        });
      }
    }

    return await persistEnvironmentsSvc.releaseLease(input.release.lease.id, releaseStatus, {
      failureReason: input.failureReason ?? (input.release.status === "failed" ? "adapter_or_run_failure" : undefined),
      cleanupStatus: input.cleanupError ? "failed" : "success",
      expectedCleanupClaimId: input.release.cleanupClaimId,
      expectedStatus: input.release.cleanupClaimId ? "pending_cleanup" : input.release.lease.status,
    });
  }

  async function finalizeSandboxRelease(input: {
    release: EnvironmentDriverReleaseInput;
    cleanupError: unknown | null;
    deleteBindings?: boolean;
    failureReason?: string;
  }): Promise<EnvironmentLease | null> {
    let finalizedLease: EnvironmentLease | null;
    if (
      !input.release.cleanupClaimId ||
      input.release.lease.leasePolicy !== "reuse_by_environment"
    ) {
      finalizedLease = await persistSandboxRelease(input);
    } else {
      finalizedLease = await db.transaction(async (tx) => {
        const transactionDb = tx as unknown as Db;
        const claimedRow = await tx
          .select()
          .from(environmentLeases)
          .where(and(
            eq(environmentLeases.id, input.release.lease.id),
            eq(environmentLeases.companyId, input.release.lease.companyId),
            eq(environmentLeases.environmentId, input.release.lease.environmentId),
            eq(environmentLeases.provider, input.release.lease.provider!),
            eq(environmentLeases.providerLeaseId, input.release.lease.providerLeaseId!),
            eq(environmentLeases.status, "pending_cleanup"),
            eq(environmentLeases.cleanupClaimId, input.release.cleanupClaimId!),
            eq(environmentLeases.reusableResourceOwner, true),
            isNull(environmentLeases.reusableAdoptionClaimId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!claimedRow) return null;

        const claimedLease = toEnvironmentLeaseSnapshot(claimedRow);
        const pendingTarget = String(claimedLease.metadata?.[PENDING_CLEANUP_RELEASE_STATUS_KEY]);
        if (input.release.status === "released" && pendingTarget === "expired") {
          return await environmentService(transactionDb).releaseLease(claimedLease.id, "pending_cleanup", {
            failureReason: claimedLease.failureReason ?? "reusable_lease_destroy_requested",
            cleanupStatus: "failed",
            expectedCleanupClaimId: input.release.cleanupClaimId,
            expectedStatus: "pending_cleanup",
            metadata: claimedLease.metadata,
          });
        }

        return await persistSandboxRelease({
          ...input,
          release: {
            ...input.release,
            lease: claimedLease,
          },
        }, transactionDb);
      });
    }

    await reconcileExecutionWorkspaceAfterSandboxCleanup(finalizedLease);
    if (finalizedLease?.status !== "pending_cleanup") {
      clearSandboxRuntimeConfig(input.release.lease.id);
    }
    return finalizedLease;
  }

  async function reconcileExecutionWorkspaceAfterSandboxCleanup(
    lease: EnvironmentLease | null,
  ) {
    if (!lease?.executionWorkspaceId || !lease.issueId) return;
    if (
      lease.status === "pending_cleanup" ||
      (lease.leasePolicy === "reuse_by_environment" &&
        (lease.status === "active" || lease.status === "released" || lease.status === "retained"))
    ) {
      return;
    }

    try {
      const issueStatus = await db
        .select({ status: issues.status })
        .from(issues)
        .where(and(
          eq(issues.id, lease.issueId),
          eq(issues.companyId, lease.companyId),
          eq(issues.executionWorkspaceId, lease.executionWorkspaceId),
        ))
        .then((rows) => rows[0]?.status ?? null);
      if (issueStatus !== "done" && issueStatus !== "cancelled") return;

      await executionWorkspacesSvc.markIdleAfterTerminalIssueCleanup({
        companyId: lease.companyId,
        executionWorkspaceId: lease.executionWorkspaceId,
      });
    } catch (err) {
      logger.warn(
        {
          err,
          leaseId: lease.id,
          issueId: lease.issueId,
          executionWorkspaceId: lease.executionWorkspaceId,
        },
        "failed to reconcile execution workspace after sandbox cleanup",
      );
    }
  }

  async function resolveSandboxProviderPlugin(input: { provider: string }) {
    const running = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: input.provider,
      workerManager: pluginWorkerManager,
      requireRunning: true,
    });
    if (running) {
      return { state: "running" as const, resolved: running };
    }

    const installed = await resolvePluginSandboxProviderDriverByKey({
      db,
      driverKey: input.provider,
      workerManager: pluginWorkerManager,
      requireRunning: false,
    });
    if (!installed) {
      return { state: "missing" as const, resolved: null };
    }

    if (installed.plugin.status !== "ready") {
      return { state: "not_ready" as const, resolved: installed };
    }

    if (!pluginWorkerManager) {
      return { state: "worker_unavailable" as const, resolved: installed };
    }

    const deadline = Date.now() + Math.max(0, pluginWorkerReadyTimeoutMs);
    while (Date.now() < deadline) {
      const retried = await resolvePluginSandboxProviderDriverByKey({
        db,
        driverKey: input.provider,
        workerManager: pluginWorkerManager,
        requireRunning: true,
      });
      if (retried) {
        return { state: "running" as const, resolved: retried };
      }
      await delay(Math.max(1, pluginWorkerReadyPollMs));
    }

    return { state: "worker_unavailable" as const, resolved: installed };
  }

  async function resolveSandboxRuntimeConfig(input: {
    environment: Environment;
    lease: EnvironmentLease;
    provider: string;
    acquisitionContext?: SandboxAcquisitionContext;
  }): Promise<Record<string, unknown>> {
    const now = Date.now();
    pruneExpiredSandboxRuntimeConfig(now);
    const cached = runtimeConfigByLeaseId.get(input.lease.id);
    if (cached && cached.expiresAt > now) {
      if (cached.provider !== input.provider) {
        throw new Error(
          `Sandbox lease "${input.lease.id}" cannot change providers from "${cached.provider}" to "${input.provider}".`,
        );
      }
      return await cached.promise;
    }

    const promise = resolveSandboxRuntimeConfigUncached(input);
    runtimeConfigByLeaseId.set(input.lease.id, {
      provider: input.provider,
      promise,
      expiresAt: now + SANDBOX_RUNTIME_CONFIG_CACHE_TTL_MS,
    });
    try {
      return await promise;
    } catch (error) {
      if (runtimeConfigByLeaseId.get(input.lease.id)?.promise === promise) {
        clearSandboxRuntimeConfig(input.lease.id);
      }
      throw error;
    }
  }

  async function resolveSandboxRuntimeConfigUncached(input: {
    environment: Environment;
    lease: EnvironmentLease;
    provider: string;
    acquisitionContext?: SandboxAcquisitionContext;
  }): Promise<Record<string, unknown>> {
    const resourceScopes = {
      agent: input.acquisitionContext?.agentId
        ?? readString(input.lease.metadata?.agentId),
    };
    const secretBindingTarget = secretBindingTargetForLease(input.lease);
    const leaseSecretBindings = secretBindingTarget
      ? await db
          .select({
            secretId: companySecretBindings.secretId,
            configPath: companySecretBindings.configPath,
          })
          .from(companySecretBindings)
          .where(and(
            eq(companySecretBindings.companyId, input.lease.companyId),
            eq(companySecretBindings.targetType, secretBindingTarget.targetType),
            eq(companySecretBindings.targetId, secretBindingTarget.targetId),
          ))
      : [];
    const restoreLeaseSecretRefs = (config: Record<string, unknown>) =>
      leaseSecretBindings.reduce(
        (restored, binding) => writeConfigValueAtPath(
          restored,
          binding.configPath,
          binding.secretId,
        ),
        config,
      );
    if (input.acquisitionContext) {
      const hasPinnedCustomImageReplay = input.acquisitionContext.customImageReplay !== undefined;
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
        ...(hasPinnedCustomImageReplay ? {} : { id: input.environment.id }),
        driver: "sandbox",
        config: restoreLeaseSecretRefs(input.acquisitionContext.config),
      }, {
        issueId: input.lease.issueId,
        heartbeatRunId: input.lease.heartbeatRunId,
        applyCustomImageTemplate: hasPinnedCustomImageReplay
          ? false
          : input.acquisitionContext.applyCustomImageTemplate,
        ...(secretBindingTarget ? { secretBindingTarget } : {}),
        resourceScopes,
      });
      const config = parsed.driver === "sandbox" && input.acquisitionContext.customImageReplay
        ? applySandboxCustomImageReplay(
            parsed.config as unknown as Record<string, unknown>,
            input.acquisitionContext.customImageReplay,
          )
        : parsed.config as unknown as Record<string, unknown>;
      if (parsed.driver !== "sandbox" || config.provider !== input.provider) {
        throw new Error(
          `Sandbox acquisition "${input.lease.id}" cannot restore its original provider config.`,
        );
      }
      return config;
    }

    const storedProviderConfig = input.lease.metadata?.[PLUGIN_SANDBOX_PROVIDER_CONFIG_KEY];
    let preferCurrentConfig = false;
    if (
      secretBindingTarget &&
      leaseSecretBindings.length === 0 &&
      input.environment.driver === "sandbox"
    ) {
      try {
        preferCurrentConfig = (await collectEnvironmentSecretRefs({
          db,
          environment: input.environment,
        })).length > 0;
      } catch {
        // The durable lease snapshot remains the fallback for invalid current config.
      }
    }
    if (
      !preferCurrentConfig &&
      isRecord(storedProviderConfig) &&
      storedProviderConfig.provider === input.provider
    ) {
      try {
        const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
          id: input.environment.id,
          driver: "sandbox",
          config: restoreLeaseSecretRefs(storedProviderConfig),
        }, {
          issueId: input.lease.issueId,
          heartbeatRunId: input.lease.heartbeatRunId,
          applyCustomImageTemplate: false,
          ...(secretBindingTarget ? { secretBindingTarget } : {}),
          resourceScopes,
        });
        if (parsed.driver === "sandbox") {
          return parsed.config as unknown as Record<string, unknown>;
        }
      } catch {
        // Current config and lease metadata below remain fallbacks when the snapshot is unavailable.
      }
    }

    if (input.environment.driver === "sandbox") {
      try {
        const parsed = await resolveEnvironmentDriverConfigForRuntime(
          db,
          input.lease.companyId,
          input.environment,
          { resourceScopes },
        );
        if (parsed.driver === "sandbox" && parsed.config.provider === input.provider) {
          return parsed.config as unknown as Record<string, unknown>;
        }
      } catch {
        // Lease metadata below remains the fallback when current config is unavailable.
      }
    }

    const metadataConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
    if (metadataConfig && metadataConfig.provider === input.provider) {
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.lease.companyId, {
        id: input.environment.id,
        driver: "sandbox",
        config: restoreLeaseSecretRefs(sanitizePluginSandboxConfigFromLeaseMetadata(metadataConfig)),
      }, {
        ...(secretBindingTarget ? { secretBindingTarget } : {}),
        resourceScopes,
      });
      if (parsed.driver === "sandbox") {
        return parsed.config as unknown as Record<string, unknown>;
      }
    }

    throw new Error(
      `Sandbox lease "${input.lease.id}" has no schema-resolvable runtime config for provider "${input.provider}".`,
    );
  }

  async function recoverSandboxLeaseAcquisition(input: {
    environment: Environment;
    lease: EnvironmentLease;
    cleanupClaimId: string;
  }): Promise<EnvironmentLease> {
    if (input.lease.providerLeaseId) return input.lease;

    const acquisitionId = readString(input.lease.metadata?.[SANDBOX_ACQUISITION_ID_KEY]);
    const acquisitionContext = readSandboxAcquisitionContext(input.lease);
    if (!acquisitionId || acquisitionId !== input.lease.id || !acquisitionContext) {
      throw new Error(`Sandbox lease reservation "${input.lease.id}" is missing durable acquisition context.`);
    }

    // A reservation that still names a reusable provider lease represents a
    // resume attempt, not an idempotent fresh acquisition. Replaying it through
    // acquire after a restart could create a second sandbox or destroy a lease
    // that another run already resumed. Terminalize only the reservation; the
    // reusable source row remains independently owned.
    if (acquisitionContext.reusableProviderLeaseId) {
      const pendingTarget = input.lease.metadata?.[PENDING_CLEANUP_RELEASE_STATUS_KEY];
      const status = pendingTarget === "released" || pendingTarget === "expired" || pendingTarget === "failed"
        ? pendingTarget
        : "failed";
      const terminal = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await txDb
          .update(environmentLeases)
          .set({
            reusableAdoptionClaimId: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(environmentLeases.companyId, input.lease.companyId),
            eq(environmentLeases.environmentId, input.lease.environmentId),
            eq(environmentLeases.provider, acquisitionContext.provider),
            eq(environmentLeases.providerLeaseId, acquisitionContext.reusableProviderLeaseId!),
            eq(environmentLeases.reusableResourceOwner, true),
            eq(environmentLeases.reusableAdoptionClaimId, input.lease.id),
            isNull(environmentLeases.cleanupClaimId),
          ));
        return await releaseLeaseAndDeleteBindings({
          lease: input.lease,
          status,
          cleanupClaimId: input.cleanupClaimId,
        }, txDb);
      });
      if (!terminal) {
        throw new Error(`Sandbox acquisition "${acquisitionId}" changed before recovery terminalization.`);
      }
      return terminal;
    }

    const config = await resolveSandboxRuntimeConfig({
      environment: input.environment,
      lease: input.lease,
      provider: acquisitionContext.provider,
      acquisitionContext,
    });

    let providerLease: PluginEnvironmentLease | Awaited<ReturnType<typeof acquireSandboxProviderLease>>;
    let providerMetadata: Record<string, unknown>;
    let expiresAt: Date | null = null;
    if (acquisitionContext.kind === "plugin") {
      if (!pluginWorkerManager || !acquisitionContext.pluginId || !acquisitionContext.pluginKey) {
        throw new Error(`Plugin-backed sandbox acquisition "${acquisitionId}" cannot run without its plugin worker.`);
      }
      const pluginProvider = await resolveSandboxProviderPlugin({ provider: acquisitionContext.provider });
      if (
        pluginProvider.state !== "running" ||
        pluginProvider.resolved.plugin.id !== acquisitionContext.pluginId ||
        pluginProvider.resolved.plugin.pluginKey !== acquisitionContext.pluginKey ||
        pluginProvider.resolved.plugin.packageName !== acquisitionContext.pluginPackageName ||
        pluginProvider.resolved.plugin.version !== acquisitionContext.pluginVersion ||
        pluginProvider.resolved.plugin.manifestJson.version !== acquisitionContext.pluginVersion
      ) {
        throw new Error(
          `Plugin-backed sandbox acquisition "${acquisitionId}" cannot resolve its original provider plugin.`,
        );
      }
      if (
        acquisitionContext.pluginSupportsAcquisitionReplay !== true ||
        pluginProvider.resolved.driver.supportsAcquisitionReplay !== true
      ) {
        throw new Error(
          `Plugin-backed sandbox provider "${acquisitionContext.provider}" does not support acquisition replay.`,
        );
      }
      const workerConfig = stripSandboxProviderEnvelope(config as unknown as SandboxEnvironmentConfig);
      try {
        providerLease = await pluginWorkerManager.call(
          acquisitionContext.pluginId,
          "environmentAcquireLease",
          {
            acquisitionId,
            driverKey: acquisitionContext.provider,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: workerConfig,
            runId: acquisitionContext.runId,
            workspaceMode: acquisitionContext.workspaceMode ?? undefined,
            agentId: acquisitionContext.agentId ?? undefined,
            executionWorkspaceId: acquisitionContext.executionWorkspaceId ?? undefined,
            adapterType: acquisitionContext.adapterType ?? undefined,
          },
          resolvePluginSandboxRpcTimeoutMs(workerConfig),
        );
      } catch (error) {
        const errorData = readPluginAcquireLeaseErrorData(error);
        if (!errorData) throw error;

        let recoveredRow: typeof environmentLeases.$inferSelect | null = null;
        try {
          recoveredRow = await db
            .update(environmentLeases)
            .set({
              provider: acquisitionContext.provider,
              providerLeaseId: errorData.providerLeaseId,
              reusableResourceOwner: input.lease.leasePolicy === "reuse_by_environment",
              reusableAdoptionClaimId: null,
              metadata: sql<Record<string, unknown>>`
                coalesce(${environmentLeases.metadata}, '{}'::jsonb)
                || ${JSON.stringify({
                  [SANDBOX_LEASE_RESERVATION_KEY]: false,
                  ...(errorData.cleanupVerifiedAcquisitionId === acquisitionId
                    ? { [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId }
                    : {}),
                })}::jsonb
              `,
              lastUsedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(
              eq(environmentLeases.id, input.lease.id),
              eq(environmentLeases.status, "pending_cleanup"),
              eq(environmentLeases.cleanupClaimId, input.cleanupClaimId),
              isNull(environmentLeases.providerLeaseId),
            ))
            .returning()
            .then((rows) => rows[0] ?? null);
        } catch (persistError) {
          const existingOwner = input.lease.leasePolicy === "reuse_by_environment"
            ? await findReusableSandboxResourceOwner({
                companyId: input.lease.companyId,
                environmentId: input.lease.environmentId,
                provider: acquisitionContext.provider,
                providerLeaseId: errorData.providerLeaseId,
                excludeLeaseId: input.lease.id,
              })
            : null;
          if (existingOwner) {
            return await terminalizeSandboxRecoveryReservationForExistingOwner(input);
          }
          logger.warn(
            {
              err: persistError,
              leaseId: input.lease.id,
              environmentId: input.environment.id,
              providerLeaseId: errorData.providerLeaseId,
            },
            "failed to persist provider lease id from acquisition replay error",
          );
          throw error;
        }

        if (recoveredRow) return toEnvironmentLeaseSnapshot(recoveredRow);

        const existingOwner = input.lease.leasePolicy === "reuse_by_environment"
          ? await findReusableSandboxResourceOwner({
              companyId: input.lease.companyId,
              environmentId: input.lease.environmentId,
              provider: acquisitionContext.provider,
              providerLeaseId: errorData.providerLeaseId,
              excludeLeaseId: input.lease.id,
            })
          : null;
        if (existingOwner) {
          return await terminalizeSandboxRecoveryReservationForExistingOwner(input);
        }

        const currentRow = await db
          .select()
          .from(environmentLeases)
          .where(eq(environmentLeases.id, input.lease.id))
          .then((rows) => rows[0] ?? null);
        if (
          currentRow?.status === "pending_cleanup" &&
          currentRow.cleanupClaimId === input.cleanupClaimId &&
          currentRow.providerLeaseId === errorData.providerLeaseId
        ) {
          return toEnvironmentLeaseSnapshot(currentRow);
        }
        throw error;
      }
      if (!providerLease.providerLeaseId) {
        throw new Error(`Plugin-backed sandbox acquisition "${acquisitionId}" returned no provider lease id.`);
      }
      providerMetadata = sanitizePluginSandboxConfigFromLeaseMetadata(
        sanitizePluginProviderLeaseMetadata({
          metadata: providerLease.metadata,
          schema: pluginProvider.resolved.driver.configSchema as Record<string, unknown> | null | undefined,
        }),
      );
      expiresAt = parseExpiresAt(providerLease.expiresAt);
    } else {
      const builtinProvider = getBuiltinSandboxProvider(acquisitionContext.provider);
      if (builtinProvider?.supportsAcquisitionReplay !== true) {
        throw new Error(
          `Built-in sandbox provider "${acquisitionContext.provider}" does not support acquisition replay.`,
        );
      }
      providerLease = await acquireSandboxProviderLease({
        acquisitionId,
        config: config as unknown as SandboxEnvironmentConfig,
        environmentId: input.environment.id,
        heartbeatRunId: acquisitionContext.runId,
        issueId: input.lease.issueId,
        agentId: acquisitionContext.agentId,
        executionWorkspaceId: acquisitionContext.executionWorkspaceId,
        reusableProviderLeaseId: acquisitionContext.reusableProviderLeaseId,
      });
      providerMetadata = providerLease.metadata ?? {};
    }

    const reusableScope = input.lease.leasePolicy === "reuse_by_environment"
      ? buildReusableSandboxLeaseScope({
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: acquisitionContext.executionWorkspaceId,
          agentId: acquisitionContext.agentId,
          adapterType: acquisitionContext.adapterType,
          provider: acquisitionContext.provider,
          config: acquisitionContext.config,
          leaseFingerprint: acquisitionContext.leaseFingerprint as EffectiveRunConfigFingerprint | null,
          providerMetadata,
        })
      : null;
    const metadata = {
      ...(input.lease.metadata ?? {}),
      ...providerMetadata,
      ...(reusableScope ? { reusableSandboxLease: reusableScope } : {}),
      provider: acquisitionContext.provider,
      [LEASE_SCOPED_SECRET_BINDINGS_KEY]: true,
      [SANDBOX_ACQUISITION_CONTEXT_KEY]: acquisitionContext,
      [SANDBOX_ACQUISITION_ID_KEY]: acquisitionId,
      [SANDBOX_LEASE_RESERVATION_KEY]: false,
    };
    let recovered: typeof environmentLeases.$inferSelect | null = null;
    try {
      recovered = await db
        .update(environmentLeases)
        .set({
          provider: acquisitionContext.provider,
          providerLeaseId: providerLease.providerLeaseId,
          expiresAt,
          reusableResourceOwner: input.lease.leasePolicy === "reuse_by_environment",
          reusableAdoptionClaimId: null,
          metadata,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(environmentLeases.id, input.lease.id),
          eq(environmentLeases.status, "pending_cleanup"),
          eq(environmentLeases.cleanupClaimId, input.cleanupClaimId),
          isNull(environmentLeases.providerLeaseId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    } catch (persistError) {
      const existingOwner = input.lease.leasePolicy === "reuse_by_environment"
        ? await findReusableSandboxResourceOwner({
            companyId: input.lease.companyId,
            environmentId: input.lease.environmentId,
            provider: acquisitionContext.provider,
            providerLeaseId: providerLease.providerLeaseId,
            excludeLeaseId: input.lease.id,
          })
        : null;
      if (existingOwner) {
        return await terminalizeSandboxRecoveryReservationForExistingOwner(input);
      }
      throw persistError;
    }
    if (!recovered) {
      const existingOwner = input.lease.leasePolicy === "reuse_by_environment"
        ? await findReusableSandboxResourceOwner({
            companyId: input.lease.companyId,
            environmentId: input.lease.environmentId,
            provider: acquisitionContext.provider,
            providerLeaseId: providerLease.providerLeaseId,
            excludeLeaseId: input.lease.id,
          })
        : null;
      if (existingOwner) {
        return await terminalizeSandboxRecoveryReservationForExistingOwner(input);
      }
      const currentRow = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, input.lease.id))
        .then((rows) => rows[0] ?? null);
      const current = currentRow ? toEnvironmentLeaseSnapshot(currentRow) : null;
      if (current?.providerLeaseId === providerLease.providerLeaseId) {
        if (currentRow?.cleanupClaimId === input.cleanupClaimId) return current;
        throw new Error(`Sandbox acquisition "${acquisitionId}" recovery is owned by another cleanup claim.`);
      }
      if (
        current?.status === "pending_cleanup" &&
        !current.providerLeaseId &&
        current.metadata?.[SANDBOX_ACQUISITION_ID_KEY] === acquisitionId &&
        isDeepStrictEqual(readSandboxAcquisitionContext(current), acquisitionContext)
      ) {
        throw new Error(`Sandbox acquisition "${acquisitionId}" remains queued for recovery.`);
      }

      const cleanupInput: Parameters<typeof environmentsSvc.acquireLease>[0] = {
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.lease.executionWorkspaceId,
        issueId: input.lease.issueId,
        heartbeatRunId: input.lease.heartbeatRunId,
        leasePolicy: input.lease.leasePolicy,
        provider: acquisitionContext.provider,
        providerLeaseId: providerLease.providerLeaseId,
        expiresAt,
        metadata,
      };
      const cleanupUnrecordedLease = async () => {
        if (acquisitionContext.kind === "plugin") {
          const workerConfig = stripSandboxProviderEnvelope(config as unknown as SandboxEnvironmentConfig);
          await pluginWorkerManager!.call(
            acquisitionContext.pluginId!,
            input.lease.leasePolicy === "reuse_by_environment"
              ? "environmentDestroyLease"
              : "environmentReleaseLease",
            {
              driverKey: acquisitionContext.provider,
              companyId: input.lease.companyId,
              environmentId: input.environment.id,
              issueId: input.lease.issueId,
              config: workerConfig,
              acquisitionId,
              providerLeaseId: providerLease.providerLeaseId,
              leaseMetadata: metadata,
            },
            resolvePluginSandboxRpcTimeoutMs(workerConfig),
          );
        } else if (input.lease.leasePolicy === "reuse_by_environment") {
          await destroySandboxProviderLease({
            config: config as unknown as SandboxEnvironmentConfig,
            providerLeaseId: providerLease.providerLeaseId,
          });
        } else {
          await releaseSandboxProviderLease({
            config: config as unknown as SandboxEnvironmentConfig,
            providerLeaseId: providerLease.providerLeaseId,
            status: "expired",
          });
        }
      };
      let cleanupLease: EnvironmentLease | null = null;
      try {
        cleanupLease = await persistStandaloneSandboxLeaseCleanup(input.lease, cleanupInput);
        await cleanupPersistedSandboxLease(input.environment, cleanupLease, "acquire_handoff_failed");
      } catch (cleanupError) {
        if (!cleanupLease) {
          const existingOwner = input.lease.leasePolicy === "reuse_by_environment"
            ? await findReusableSandboxResourceOwner({
                companyId: input.lease.companyId,
                environmentId: input.lease.environmentId,
                provider: acquisitionContext.provider,
                providerLeaseId: providerLease.providerLeaseId,
                excludeLeaseId: input.lease.id,
              })
            : null;
          if (existingOwner) {
            return await terminalizeSandboxRecoveryReservationForExistingOwner(input);
          }
          try {
            await cleanupUnrecordedLease();
          } catch (unrecordedCleanupError) {
            logger.error(
              {
                err: unrecordedCleanupError,
                handoffErr: cleanupError,
                environmentId: input.environment.id,
                providerLeaseId: providerLease.providerLeaseId,
              },
              "failed to clean up unrecorded sandbox lease after recovery handoff failure",
            );
          }
        } else {
          logger.error(
            {
              err: cleanupError,
              environmentId: input.environment.id,
              providerLeaseId: providerLease.providerLeaseId,
            },
            "failed to clean up persisted sandbox lease after recovery handoff failure",
          );
        }
      }
      throw new Error(`Sandbox acquisition "${acquisitionId}" changed before recovery handoff.`);
    }
    return toEnvironmentLeaseSnapshot(recovered);
  }

  async function cleanupObsoleteReusableSandboxLeases(input: {
    environment: Environment;
    leases: EnvironmentLease[];
    reusableLeases: EnvironmentLease[];
  }) {
    const reusableIds = new Set(input.reusableLeases.map((lease) => lease.id));
    for (const lease of input.leases) {
      if (reusableIds.has(lease.id)) continue;
      if (!reusableLeaseCanBeCleanedUp(lease)) continue;
      await destroyReusableSandboxLease({
        environment: input.environment,
        lease,
        failureReason: "lease_fingerprint_mismatch",
      });
    }
  }

  return {
    driver: "sandbox",

    async acquireRunLease(input) {
      const storedParsed = parseEnvironmentDriverConfig(input.environment);
      const parsed = await resolveEnvironmentDriverConfigForRuntime(db, input.companyId, input.environment, {
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
        resourceScopes: { agent: input.agentId },
      });
      if (parsed.driver !== "sandbox" || storedParsed.driver !== "sandbox") {
        throw new Error(`Expected sandbox environment config for driver "${input.environment.driver}".`);
      }

      // Check if this provider should be handled by a plugin.
      if (!isBuiltinSandboxProvider(parsed.config.provider)) {
        const pluginProvider = await resolveSandboxProviderPlugin({
          provider: parsed.config.provider,
        });
        if (pluginProvider.state === "missing") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is not registered as a built-in provider and no matching plugin is available.`,
          );
        }
        if (pluginProvider.state === "not_ready") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed via plugin "${pluginProvider.resolved.plugin.pluginKey}", but that plugin is currently ${pluginProvider.resolved.plugin.status}.`,
          );
        }
        if (pluginProvider.state === "worker_unavailable") {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed via plugin "${pluginProvider.resolved.plugin.pluginKey}", but its worker is not running.`,
          );
        }
        if (!pluginWorkerManager) {
          throw new Error(
            `Sandbox provider "${parsed.config.provider}" is installed, but sandbox plugin workers are unavailable in this server process.`,
          );
        }

        const workerConfig = stripSandboxProviderEnvelope(parsed.config);
        const storedConfig = storedParsed.config;
        const providerConfigSchema = pluginProvider.resolved.driver.configSchema as
          | Record<string, unknown>
          | null
          | undefined;
        // Preserve original indexes for lease-scoped binding paths. Runtime
        // resolution compacts the selected rows before the provider RPC.
        const scopedStoredConfig = scopeConfigResourceArrays(
          providerConfigSchema,
          storedConfig as unknown as Record<string, unknown>,
          { agent: input.agentId },
        ) as SandboxEnvironmentConfig;
        const providerConfigForLease = stripSecretRefsFromPluginConfigSnapshot({
          config: sandboxConfigForLeaseMetadata(scopedStoredConfig),
          schema: providerConfigSchema,
        });
        const supportsReusableLeases = pluginProvider.resolved.driver.supportsReusableLeases === true;
        const leaseFingerprint =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
            ? await buildReusableSandboxLeaseFingerprint({
                db,
                companyId: input.companyId,
                environment: input.environment,
                executionWorkspaceId: input.executionWorkspaceId,
                agentId: input.agentId,
                adapterType: input.adapterType,
                provider: parsed.config.provider,
                providerConfig: providerConfigForLease,
                resolvedSecretVersions: parsed.resolvedSecretVersions ?? [],
                providerPlugin: {
                  id: pluginProvider.resolved.plugin.id,
                  pluginKey: pluginProvider.resolved.plugin.pluginKey,
                  packageName: pluginProvider.resolved.plugin.packageName,
                  version: pluginProvider.resolved.plugin.version,
                },
              })
            : null;
        // Ad-hoc tests (heartbeatRunId === null) must never resume an existing
        // provider lease. If they did, releasing the test lease at the end of
        // the probe would tear down the live heartbeat run that owns it.
        // We also filter out leases whose policy is not reuse_by_environment
        // and whose status is not reusable so non-reusable, cleanup-pending,
        // or terminal rows cannot be matched.
        const reusableCandidateLeases =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
          ? (await environmentsSvc.listLeases(input.environment.id))
              .filter((lease) =>
                lease.leasePolicy === "reuse_by_environment" &&
                reusableLeaseCanBeResumed({ lease, heartbeatRunId: input.heartbeatRunId }) &&
                lease.executionWorkspaceId === input.executionWorkspaceId &&
                lease.metadata?.agentId === input.agentId,
              )
          : [];
        const reusableExistingLeases = reusableCandidateLeases.filter((lease) =>
          reusableSandboxLeaseScopeMatches({
            lease,
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            agentId: input.agentId,
            adapterType: input.adapterType,
            provider: parsed.config.provider,
            config: providerConfigForLease,
            leaseFingerprint,
            allowLegacyRuntimeFingerprint:
              lease.status === "active" &&
              input.heartbeatRunId !== null &&
              lease.heartbeatRunId === input.heartbeatRunId,
          }),
        );
        if (reusableCandidateLeases.length > reusableExistingLeases.length) {
          await cleanupObsoleteReusableSandboxLeases({
            environment: input.environment,
            leases: reusableCandidateLeases,
            reusableLeases: reusableExistingLeases,
          });
        }
        const reusableProviderLeaseId =
          supportsReusableLeases &&
          parsed.config.reuseLease &&
          input.heartbeatRunId !== null &&
          input.executionWorkspaceId !== null &&
          input.agentId !== null
          ? findReusableSandboxLeaseId({ config: storedConfig, leases: reusableExistingLeases })
          : null;
        const reusableLease = reusableProviderLeaseId
          ? reusableExistingLeases.find((lease) => lease.providerLeaseId === reusableProviderLeaseId)
          : null;
        const acquisitionId = randomUUID();
        const resolvedLeasePolicy = supportsReusableLeases && parsed.config.reuseLease && input.heartbeatRunId !== null
          ? "reuse_by_environment"
          : "ephemeral";
        const fallbackLeaseMetadataBase = {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          pluginId: pluginProvider.resolved.plugin.id,
          pluginKey: pluginProvider.resolved.plugin.pluginKey,
          sandboxProviderPlugin: true,
          ...sanitizePluginSandboxConfigFromLeaseMetadata(providerConfigForLease),
          [PLUGIN_SANDBOX_PROVIDER_CONFIG_KEY]: providerConfigForLease,
        };
        const acquisitionContext: SandboxAcquisitionContext = {
          version: 1,
          kind: "plugin",
          provider: parsed.config.provider,
          pluginId: pluginProvider.resolved.plugin.id,
          pluginKey: pluginProvider.resolved.plugin.pluginKey,
          pluginPackageName: pluginProvider.resolved.plugin.packageName,
          pluginVersion: pluginProvider.resolved.plugin.version,
          pluginSupportsAcquisitionReplay:
            pluginProvider.resolved.driver.supportsAcquisitionReplay === true,
          config: providerConfigForLease,
          runId: input.heartbeatRunId ?? acquisitionId,
          workspaceMode: input.executionWorkspaceMode,
          agentId: input.agentId,
          executionWorkspaceId: input.executionWorkspaceId,
          adapterType: input.adapterType,
          applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
          customImageReplay: buildSandboxCustomImageReplay({
            storedConfig,
            runtimeConfig: parsed.config,
            schema: providerConfigSchema,
          }),
          reusableProviderLeaseId,
          leaseFingerprint: serializeLeaseFingerprint(leaseFingerprint),
        };
        let fallbackLeaseMetadata = {
          ...fallbackLeaseMetadataBase,
          [SANDBOX_ACQUISITION_ID_KEY]: acquisitionId,
          [SANDBOX_ACQUISITION_CONTEXT_KEY]: acquisitionContext,
        };
        const reservation = await reserveSandboxLease(input, {
          id: acquisitionId,
          provider: parsed.config.provider,
          leasePolicy: resolvedLeasePolicy,
          metadata: fallbackLeaseMetadata,
        }, parsed.resolvedSecretVersions ?? []);

        let providerLease: PluginEnvironmentLease | null = null;
        let supersededLease: EnvironmentLease | null = null;
        let adoptedReusableLease: EnvironmentLease | null = null;
        let adoptionClaimId: string | null = null;
        try {
          if (reusableLease?.providerLeaseId) {
            adoptedReusableLease = await claimReusableSandboxLeaseForAdoption(
              reusableLease,
              reservation.id,
            );
            if (adoptedReusableLease) {
              const claimedAdoptionId = reservation.id;
              adoptionClaimId = claimedAdoptionId;
              try {
                const resumed = await pluginWorkerManager.call(
                  pluginProvider.resolved.plugin.id,
                  "environmentResumeLease",
                  {
                    driverKey: parsed.config.provider,
                    companyId: input.companyId,
                    environmentId: input.environment.id,
                    issueId: input.issueId,
                    config: workerConfig,
                    providerLeaseId: adoptedReusableLease.providerLeaseId!,
                    leaseMetadata: adoptedReusableLease.metadata ?? undefined,
                  },
                  resolvePluginSandboxRpcTimeoutMs(workerConfig),
                );
                providerLease =
                  typeof resumed.providerLeaseId === "string" && resumed.providerLeaseId.length > 0
                    ? resumed
                    : null;
                supersededLease =
                  providerLease?.providerLeaseId === adoptedReusableLease.providerLeaseId
                    ? adoptedReusableLease
                    : null;
              } catch {
                providerLease = null;
              }
              if (!providerLease) {
                const destroyed = await destroyReusableSandboxLeaseAfterFailedResume({
                  environment: input.environment,
                  lease: adoptedReusableLease,
                  adoptionClaimId: claimedAdoptionId,
                });
                if (!destroyed) {
                  await clearReusableSandboxAdoptionClaim(adoptedReusableLease, claimedAdoptionId);
                }
                adoptionClaimId = null;
              }
              if (providerLease && !supersededLease) {
                const replacementMetadata = {
                  ...fallbackLeaseMetadata,
                  ...sanitizePluginSandboxConfigFromLeaseMetadata(
                    sanitizePluginProviderLeaseMetadata({
                      metadata: providerLease.metadata,
                      schema: providerConfigSchema,
                    }),
                  ),
                  provider: parsed.config.provider,
                };
                await clearReusableSandboxAdoptionClaim(adoptedReusableLease, claimedAdoptionId);
                adoptionClaimId = null;
                await compensateFailedSandboxLeaseAcquisition(
                  input.environment,
                  {
                    companyId: input.companyId,
                    environmentId: input.environment.id,
                    executionWorkspaceId: input.executionWorkspaceId,
                    issueId: input.issueId,
                    heartbeatRunId: input.heartbeatRunId,
                    leasePolicy: resolvedLeasePolicy,
                    provider: parsed.config.provider,
                    providerLeaseId: providerLease.providerLeaseId,
                    expiresAt: providerLease.expiresAt ? new Date(providerLease.expiresAt) : undefined,
                    metadata: replacementMetadata,
                  },
                  reservation,
                  async () => await pluginWorkerManager.call(
                    pluginProvider.resolved.plugin.id,
                    "environmentDestroyLease",
                    {
                      driverKey: parsed.config.provider,
                      companyId: input.companyId,
                      environmentId: input.environment.id,
                      issueId: input.issueId,
                      config: workerConfig,
                      acquisitionId: reservation.id,
                      providerLeaseId: providerLease!.providerLeaseId,
                      leaseMetadata: replacementMetadata,
                    },
                    resolvePluginSandboxRpcTimeoutMs(workerConfig),
                  ),
                );
                throw new Error(
                  `Plugin-backed sandbox provider "${parsed.config.provider}" changed its lease id during resume.`,
                );
              }
            }
          }
        } catch (error) {
          if (adoptedReusableLease && adoptionClaimId) {
            await clearReusableSandboxAdoptionClaim(adoptedReusableLease, adoptionClaimId);
          }
          const currentReservation = await environmentsSvc.getLeaseById(reservation.id);
          if (!currentReservation?.providerLeaseId) {
            await abandonSandboxLeaseReservation(reservation, "provider_acquire_failed");
          }
          throw error;
        }
        if (!providerLease && acquisitionContext.reusableProviderLeaseId) {
          const clearedContext = await clearReusableSandboxAcquisitionContext({
            reservation,
            acquisitionContext,
          });
          fallbackLeaseMetadata = {
            ...fallbackLeaseMetadata,
            [SANDBOX_ACQUISITION_CONTEXT_KEY]: clearedContext,
          };
        }
        let acquiredLease: PluginEnvironmentLease;
        try {
          acquiredLease = providerLease ?? await pluginWorkerManager.call(
            pluginProvider.resolved.plugin.id,
            "environmentAcquireLease",
            {
              acquisitionId: reservation.id,
              driverKey: parsed.config.provider,
              companyId: input.companyId,
              environmentId: input.environment.id,
              issueId: input.issueId,
              config: workerConfig,
              // Plugin SDK requires a string; ad-hoc test leases use a fresh
              // UUID so providers that validate or persist the runId still see
              // a well-formed identifier.
              runId: acquisitionContext.runId,
              workspaceMode: input.executionWorkspaceMode ?? undefined,
              agentId: input.agentId ?? undefined,
              executionWorkspaceId: input.executionWorkspaceId ?? undefined,
              // The agent's harness for THIS run, so the plugin picks the matching
              // runtime image (per-run adapter, mixed-harness environments).
              // NOTE: environment-runtime.ts has TWO drivers calling
              // environmentAcquireLease; this plugin-sandbox one is the HEARTBEAT
              // path. Omitting adapterType here silently falls back to the
              // environment's default adapter image (a pi agent then runs in the
              // opencode image and the harness binary is missing at exec time).
              adapterType: input.adapterType ?? undefined,
            },
            resolvePluginSandboxRpcTimeoutMs(workerConfig),
          );
        } catch (error) {
          const errorData = readPluginAcquireLeaseErrorData(error);
          if (!errorData) {
            await deferSandboxLeaseReservation(reservation, "failed", "provider_acquire_outcome_unknown");
            throw error;
          }

          const cleanupMetadata = {
            ...fallbackLeaseMetadata,
            [SANDBOX_LEASE_RESERVATION_KEY]: false,
            ...(errorData.cleanupVerifiedAcquisitionId === reservation.id
              ? { [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: reservation.id }
              : {}),
          };
          await compensateFailedSandboxLeaseAcquisition(
            input.environment,
            {
              companyId: input.companyId,
              environmentId: input.environment.id,
              executionWorkspaceId: input.executionWorkspaceId,
              issueId: input.issueId,
              heartbeatRunId: input.heartbeatRunId,
              leasePolicy: resolvedLeasePolicy,
              provider: parsed.config.provider,
              providerLeaseId: errorData.providerLeaseId,
              metadata: cleanupMetadata,
            },
            reservation,
            async () => await pluginWorkerManager.call(
              pluginProvider.resolved.plugin.id,
              resolvedLeasePolicy === "reuse_by_environment"
                ? "environmentDestroyLease"
                : "environmentReleaseLease",
              {
                driverKey: parsed.config.provider,
                companyId: input.companyId,
                environmentId: input.environment.id,
                issueId: input.issueId,
                config: workerConfig,
                acquisitionId: reservation.id,
                providerLeaseId: errorData.providerLeaseId,
                leaseMetadata: cleanupMetadata,
              },
              resolvePluginSandboxRpcTimeoutMs(workerConfig),
            ),
          );
          throw error;
        }
        if (!acquiredLease.providerLeaseId) {
          await deferSandboxLeaseReservation(reservation, "failed", "provider_acquire_outcome_unknown");
          throw new Error(
            `Plugin-backed sandbox acquisition "${reservation.id}" returned no provider lease id.`,
          );
        }

        const fallbackLeaseInput: Parameters<typeof environmentsSvc.acquireLease>[0] = {
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          leasePolicy: resolvedLeasePolicy,
          provider: parsed.config.provider,
          providerLeaseId: acquiredLease.providerLeaseId,
          expiresAt: acquiredLease.expiresAt ? new Date(acquiredLease.expiresAt) : undefined,
          metadata: fallbackLeaseMetadata,
        };
        const cleanupAcquiredPluginLease = async (leaseMetadata: Record<string, unknown>) => {
          await pluginWorkerManager.call(
            pluginProvider.resolved.plugin.id,
            resolvedLeasePolicy === "reuse_by_environment"
              ? "environmentDestroyLease"
              : "environmentReleaseLease",
            {
              driverKey: parsed.config.provider,
              companyId: input.companyId,
              environmentId: input.environment.id,
              issueId: input.issueId,
              config: workerConfig,
              acquisitionId: reservation.id,
              providerLeaseId: acquiredLease.providerLeaseId,
              leaseMetadata,
            },
            resolvePluginSandboxRpcTimeoutMs(workerConfig),
          );
        };

        let handoffStarted = false;
        try {
          // Ad-hoc test leases are never publishable for reuse: storing them
          // as `reuse_by_environment` would let a concurrent heartbeat resume
          // the test's provider lease and lose its sandbox when the test ends.
          const sanitizedProviderMetadata = sanitizePluginSandboxConfigFromLeaseMetadata(
            sanitizePluginProviderLeaseMetadata({
              metadata: acquiredLease.metadata,
              schema: providerConfigSchema,
            }),
          );
          const reusableScope = resolvedLeasePolicy === "reuse_by_environment"
            ? buildReusableSandboxLeaseScope({
                companyId: input.companyId,
                environmentId: input.environment.id,
                executionWorkspaceId: input.executionWorkspaceId,
                agentId: input.agentId,
                adapterType: input.adapterType,
                provider: parsed.config.provider,
                config: providerConfigForLease,
                leaseFingerprint,
                providerMetadata: sanitizedProviderMetadata,
              })
            : null;
          const leaseMetadata = {
            ...fallbackLeaseMetadata,
            ...sanitizedProviderMetadata,
            provider: parsed.config.provider,
            ...(reusableScope ? { reusableSandboxLease: reusableScope } : {}),
          };
          handoffStarted = true;
          return await acquireSandboxLeaseWithCompensation(
            input.environment,
            { ...fallbackLeaseInput, metadata: leaseMetadata },
            reservation,
            parsed.resolvedSecretVersions ?? [],
            supersededLease,
            adoptionClaimId,
            async () => await cleanupAcquiredPluginLease(leaseMetadata),
          );
        } catch (error) {
          if (!handoffStarted) {
            if (supersededLease) {
              await abandonSandboxLeaseReservation(reservation, "acquire_handoff_failed");
            } else {
              await compensateFailedSandboxLeaseAcquisition(
                input.environment,
                fallbackLeaseInput,
                reservation,
                async () => await cleanupAcquiredPluginLease(fallbackLeaseMetadata),
              );
            }
          }
          throw error;
        }
      }

      // Built-in sandbox provider path. Same guard as the plugin-backed path:
      // ad-hoc tests (heartbeatRunId === null) must never resume an existing
      // provider lease, or releasing the test lease will terminate the live
      // heartbeat run that shares it. Filter to reusable policies and statuses
      // so non-reusable, cleanup-pending, or terminal rows can never be matched.
      const builtinSandboxProvider = getBuiltinSandboxProvider(parsed.config.provider);
      const supportsReusableLeases = builtinSandboxProvider?.supportsReusableLeases === true;
      const providerConfigForLease = sandboxConfigForLeaseMetadata(storedParsed.config);
      const leaseFingerprint =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? await buildReusableSandboxLeaseFingerprint({
              db,
              companyId: input.companyId,
              environment: input.environment,
              executionWorkspaceId: input.executionWorkspaceId,
              agentId: input.agentId,
              adapterType: input.adapterType,
              provider: parsed.config.provider,
              providerConfig: providerConfigForLease,
              resolvedSecretVersions: parsed.resolvedSecretVersions ?? [],
            })
          : null;
      const reusableCandidateLeases =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? (await environmentsSvc.listLeases(input.environment.id))
              .filter((lease) =>
                lease.leasePolicy === "reuse_by_environment" &&
                reusableLeaseCanBeResumed({ lease, heartbeatRunId: input.heartbeatRunId }) &&
                lease.executionWorkspaceId === input.executionWorkspaceId &&
                lease.metadata?.agentId === input.agentId,
              )
          : [];
      const reusableExistingLeases = reusableCandidateLeases.filter((lease) =>
        reusableSandboxLeaseScopeMatches({
          lease,
          companyId: input.companyId,
          environmentId: input.environment.id,
          executionWorkspaceId: input.executionWorkspaceId,
          agentId: input.agentId,
          adapterType: input.adapterType,
          provider: parsed.config.provider,
          config: providerConfigForLease,
          leaseFingerprint,
          allowLegacyRuntimeFingerprint:
            lease.status === "active" &&
            input.heartbeatRunId !== null &&
            lease.heartbeatRunId === input.heartbeatRunId,
        }),
      );
      if (reusableCandidateLeases.length > reusableExistingLeases.length) {
        await cleanupObsoleteReusableSandboxLeases({
          environment: input.environment,
          leases: reusableCandidateLeases,
          reusableLeases: reusableExistingLeases,
        });
      }
      const reusableProviderLeaseId =
        supportsReusableLeases &&
        parsed.config.reuseLease &&
        input.heartbeatRunId !== null &&
        input.executionWorkspaceId !== null &&
        input.agentId !== null
          ? findReusableSandboxLeaseId({ config: parsed.config, leases: reusableExistingLeases })
        : null;
      const reusableLease = reusableProviderLeaseId
        ? reusableExistingLeases.find((lease) => lease.providerLeaseId === reusableProviderLeaseId)
        : null;
      const acquisitionId = randomUUID();
      const resolvedLeasePolicy = supportsReusableLeases && parsed.config.reuseLease && input.heartbeatRunId !== null
        ? "reuse_by_environment"
        : "ephemeral";
      const fallbackLeaseMetadataBase = {
        ...(input.agentId ? { agentId: input.agentId } : {}),
        driver: input.environment.driver,
        executionWorkspaceMode: input.executionWorkspaceMode,
        [PLUGIN_SANDBOX_PROVIDER_CONFIG_KEY]: providerConfigForLease,
      };
      const acquisitionContext: SandboxAcquisitionContext = {
        version: 1,
        kind: "builtin",
        provider: parsed.config.provider,
        config: providerConfigForLease,
        runId: input.heartbeatRunId ?? acquisitionId,
        workspaceMode: input.executionWorkspaceMode,
        agentId: input.agentId,
        executionWorkspaceId: input.executionWorkspaceId,
        adapterType: input.adapterType,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
        customImageReplay: buildSandboxCustomImageReplay({
          storedConfig: storedParsed.config,
          runtimeConfig: parsed.config,
        }),
        reusableProviderLeaseId,
        leaseFingerprint: serializeLeaseFingerprint(leaseFingerprint),
      };
      let fallbackLeaseMetadata = {
        ...fallbackLeaseMetadataBase,
        [SANDBOX_ACQUISITION_ID_KEY]: acquisitionId,
        [SANDBOX_ACQUISITION_CONTEXT_KEY]: acquisitionContext,
      };
      const reservation = await reserveSandboxLease(input, {
        id: acquisitionId,
        provider: parsed.config.provider,
        leasePolicy: resolvedLeasePolicy,
        metadata: fallbackLeaseMetadata,
      }, parsed.resolvedSecretVersions ?? []);

      let providerLease: Awaited<ReturnType<typeof acquireSandboxProviderLease>> | null = null;
      let supersededLease: EnvironmentLease | null = null;
      let adoptedReusableLease: EnvironmentLease | null = null;
      let adoptionClaimId: string | null = null;
      try {
        if (reusableLease?.providerLeaseId) {
          adoptedReusableLease = await claimReusableSandboxLeaseForAdoption(
            reusableLease,
            reservation.id,
          );
          if (adoptedReusableLease) {
            const claimedAdoptionId = reservation.id;
            adoptionClaimId = claimedAdoptionId;
            try {
              providerLease = await resumeSandboxProviderLease({
                config: parsed.config,
                providerLeaseId: adoptedReusableLease.providerLeaseId!,
              });
            } catch {
              providerLease = null;
            }
            supersededLease = providerLease?.providerLeaseId === adoptedReusableLease.providerLeaseId
              ? adoptedReusableLease
              : null;
            if (!providerLease) {
              const destroyed = await destroyReusableSandboxLeaseAfterFailedResume({
                environment: input.environment,
                lease: adoptedReusableLease,
                adoptionClaimId: claimedAdoptionId,
              });
              if (!destroyed) {
                await clearReusableSandboxAdoptionClaim(adoptedReusableLease, claimedAdoptionId);
              }
              adoptionClaimId = null;
            } else if (!supersededLease) {
              const replacementMetadata = {
                ...fallbackLeaseMetadata,
                ...(providerLease.metadata ?? {}),
                provider: parsed.config.provider,
              };
              await clearReusableSandboxAdoptionClaim(adoptedReusableLease, claimedAdoptionId);
              adoptionClaimId = null;
              await compensateFailedSandboxLeaseAcquisition(
                input.environment,
                {
                  companyId: input.companyId,
                  environmentId: input.environment.id,
                  executionWorkspaceId: input.executionWorkspaceId,
                  issueId: input.issueId,
                  heartbeatRunId: input.heartbeatRunId,
                  leasePolicy: resolvedLeasePolicy,
                  provider: parsed.config.provider,
                  providerLeaseId: providerLease.providerLeaseId,
                  metadata: replacementMetadata,
                },
                reservation,
                async () => await destroySandboxProviderLease({
                  config: parsed.config,
                  providerLeaseId: providerLease!.providerLeaseId,
                }),
              );
              throw new Error(
                `Built-in sandbox provider "${parsed.config.provider}" changed its lease id during resume.`,
              );
            }
          }
        }
        if (!providerLease) {
          if (acquisitionContext.reusableProviderLeaseId) {
            const clearedContext = await clearReusableSandboxAcquisitionContext({
              reservation,
              acquisitionContext,
            });
            fallbackLeaseMetadata = {
              ...fallbackLeaseMetadata,
              [SANDBOX_ACQUISITION_CONTEXT_KEY]: clearedContext,
            };
          }
          providerLease = await acquireSandboxProviderLease({
            acquisitionId: reservation.id,
            config: parsed.config,
            environmentId: input.environment.id,
            heartbeatRunId: acquisitionContext.runId,
            issueId: input.issueId,
            agentId: input.agentId,
            executionWorkspaceId: input.executionWorkspaceId,
            reusableProviderLeaseId: null,
          });
        }
      } catch (error) {
        if (adoptedReusableLease && adoptionClaimId) {
          await clearReusableSandboxAdoptionClaim(adoptedReusableLease, adoptionClaimId);
        }
        await deferSandboxLeaseReservation(reservation, "failed", "provider_acquire_outcome_unknown");
        throw error;
      }
      if (!providerLease.providerLeaseId) {
        await deferSandboxLeaseReservation(reservation, "failed", "provider_acquire_outcome_unknown");
        throw new Error(
          `Built-in sandbox acquisition "${reservation.id}" returned no provider lease id.`,
        );
      }
      const fallbackLeaseInput: Parameters<typeof environmentsSvc.acquireLease>[0] = {
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: resolvedLeasePolicy,
        provider: parsed.config.provider,
        providerLeaseId: providerLease.providerLeaseId,
        metadata: fallbackLeaseMetadata,
      };
      const cleanupAcquiredBuiltinLease = async () => {
        if (resolvedLeasePolicy === "reuse_by_environment") {
          await destroySandboxProviderLease({
            config: parsed.config,
            providerLeaseId: providerLease.providerLeaseId,
          });
          return;
        }
        await releaseSandboxProviderLease({
          config: parsed.config,
          providerLeaseId: providerLease.providerLeaseId,
          status: "expired",
        });
      };

      let handoffStarted = false;
      try {
        // Same ephemeral-policy-for-tests guard as the plugin-backed path:
        // ad-hoc test leases must not be publishable for reuse.
        const reusableScope = resolvedLeasePolicy === "reuse_by_environment"
          ? buildReusableSandboxLeaseScope({
              companyId: input.companyId,
              environmentId: input.environment.id,
              executionWorkspaceId: input.executionWorkspaceId,
              agentId: input.agentId,
              adapterType: input.adapterType,
              provider: parsed.config.provider,
              config: providerConfigForLease,
              leaseFingerprint,
              providerMetadata: providerLease.metadata,
            })
          : null;
        const leaseMetadata = {
          ...fallbackLeaseMetadata,
          ...providerLease.metadata,
          [PLUGIN_SANDBOX_PROVIDER_CONFIG_KEY]: providerConfigForLease,
          ...(reusableScope ? { reusableSandboxLease: reusableScope } : {}),
        };
        handoffStarted = true;
        return await acquireSandboxLeaseWithCompensation(
          input.environment,
          { ...fallbackLeaseInput, metadata: leaseMetadata },
          reservation,
          parsed.resolvedSecretVersions ?? [],
          supersededLease,
          adoptionClaimId,
          cleanupAcquiredBuiltinLease,
        );
      } catch (error) {
        if (!handoffStarted) {
          if (supersededLease) {
            await abandonSandboxLeaseReservation(reservation, "acquire_handoff_failed");
          } else {
            await compensateFailedSandboxLeaseAcquisition(
              input.environment,
              fallbackLeaseInput,
              reservation,
              cleanupAcquiredBuiltinLease,
            );
          }
        }
        throw error;
      }
    },

    async releaseRunLease(input) {
      if (
        input.lease.metadata?.[SANDBOX_LEASE_RESERVATION_KEY] === true &&
        !input.lease.providerLeaseId
      ) {
        const now = new Date();
        const reservedRow = await db
          .update(environmentLeases)
          .set({
            status: "pending_cleanup",
            releasedAt: now,
            lastUsedAt: now,
            updatedAt: now,
            failureReason: "provider_acquire_in_progress",
            cleanupStatus: "failed",
            cleanupClaimId: null,
            cleanupClaimedAt: null,
            metadata: sql<Record<string, unknown>>`
              coalesce(${environmentLeases.metadata}, '{}'::jsonb)
              || ${JSON.stringify({
                [PENDING_CLEANUP_RELEASE_STATUS_KEY]: input.status,
              })}::jsonb
            `,
          })
          .where(and(
            eq(environmentLeases.id, input.lease.id),
            eq(environmentLeases.status, "active"),
            isNull(environmentLeases.providerLeaseId),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (reservedRow) return toEnvironmentLeaseSnapshot(reservedRow);

        // Provider handoff may have populated this same row after
        // releaseRunLeases selected the reservation. Reload so release uses
        // the durable provider identity/config instead of stale metadata.
        const currentRow = await db
          .select()
          .from(environmentLeases)
          .where(eq(environmentLeases.id, input.lease.id))
          .then((rows) => rows[0] ?? null);
        if (!currentRow) return null;
        if (currentRow.status !== "active") return toEnvironmentLeaseSnapshot(currentRow);
        input = {
          ...input,
          lease: toEnvironmentLeaseSnapshot(currentRow),
        };
      }

      if (
        ["expired", "failed"].includes(input.status) &&
        input.lease.leasePolicy === "reuse_by_environment"
      ) {
        return await destroyReusableSandboxLease({
          environment: input.environment,
          lease: input.lease,
          failureReason: input.status === "failed" ? "adapter_or_run_failure" : "lease_expired",
          cleanupClaimId: input.cleanupClaimId,
        });
      }

      // Check if this lease was acquired through a plugin.
      if (input.lease.metadata?.sandboxProviderPlugin) {
        return await releasePluginBackedSandboxLease(input);
      }

      const metadataConfig = sandboxConfigFromLeaseMetadata(input.lease);

      // If no built-in provider handles this metadata, try plugin path.
      if (!metadataConfig) {
        const looseConfig = sandboxConfigFromLeaseMetadataLoose(input.lease);
        if (looseConfig && !isBuiltinSandboxProvider(looseConfig.provider)) {
          return await releasePluginBackedSandboxLease(input);
        }
      }

      let cleanupError: unknown | null = null;
      try {
        const providerKey = readString(input.lease.metadata?.provider) ?? metadataConfig?.provider;
        if (!providerKey) throw new Error(`Sandbox lease "${input.lease.id}" has no provider.`);
        const config = await resolveSandboxRuntimeConfig({
          environment: input.environment,
          lease: input.lease,
          provider: providerKey,
        });
        await releaseSandboxProviderLease({
          config: config as unknown as SandboxEnvironmentConfig,
          providerLeaseId: input.lease.providerLeaseId,
          status: input.status,
        });
      } catch (error) {
        cleanupError = error;
      }
      return await finalizeSandboxRelease({
        release: input,
        cleanupError,
      });
    },

    async recoverPendingAcquisition(input) {
      return await recoverSandboxLeaseAcquisition(input);
    },

    async realizeWorkspace(input) {
      // Plugin-backed sandbox providers: delegate workspace realization.
      if (input.lease.metadata?.sandboxProviderPlugin && pluginWorkerManager) {
        const pluginId = readString(input.lease.metadata?.pluginId);
        const providerKey =
          readString(input.lease.metadata?.provider) ??
          (input.environment.driver === "sandbox"
            ? (parseEnvironmentDriverConfig(input.environment).config as SandboxEnvironmentConfig).provider
            : null);
        if (pluginId && providerKey) {
          const config = await resolveSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          const result = await pluginWorkerManager.call(pluginId, "environmentRealizeWorkspace", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            env: input.env,
            workspace: input.workspace,
          }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
          const record = buildWorkspaceRealizationRecordFromDriverInput({
            environment: input.environment,
            lease: input.lease,
            workspace: input.workspace,
            cwd: result.cwd,
            providerMetadata: result.metadata,
            credentialOwnerAgentId: resolveRealizationCredentialOwnerAgentId(input),
            forwardedCredentialValues: resolveForwardedCredentialValues(input),
          });
          return {
            cwd: result.cwd,
            metadata: {
              workspaceRealization: record,
            },
          };
        }
      }

      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd:
          typeof input.lease.metadata?.remoteCwd === "string" && input.lease.metadata.remoteCwd.trim().length > 0
            ? input.lease.metadata.remoteCwd.trim()
            : input.workspace.remotePath ?? input.workspace.localPath ?? null,
        credentialOwnerAgentId: resolveRealizationCredentialOwnerAgentId(input),
      });
      return {
        cwd: record.remote.path ?? record.local.path,
        metadata: {
          workspaceRealization: record,
        },
      };
    },

    async execute(input) {
      // Plugin-backed sandbox providers: delegate command execution.
      if (input.lease.metadata?.sandboxProviderPlugin && pluginWorkerManager) {
        const pluginId = readString(input.lease.metadata?.pluginId);
        const providerKey = readString(input.lease.metadata?.provider);
        if (pluginId && providerKey) {
          const config = await resolveSandboxRuntimeConfig({
            environment: input.environment,
            lease: input.lease,
            provider: providerKey,
          });
          const sanitizedConfig = stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig);
          return await pluginWorkerManager.call(pluginId, "environmentExecute", {
            driverKey: providerKey,
            companyId: input.lease.companyId,
            environmentId: input.environment.id,
            issueId: input.lease.issueId,
            config: sanitizedConfig,
            lease: {
              providerLeaseId: input.lease.providerLeaseId,
              metadata: input.lease.metadata ?? undefined,
              expiresAt: input.lease.expiresAt?.toISOString() ?? null,
            },
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
            stdin: input.stdin,
            timeoutMs: input.timeoutMs,
            ...(input.workspaceRealization
              ? { workspaceRealization: input.workspaceRealization }
              : {}),
          }, resolvePluginExecuteRpcTimeoutMs({
            requestedTimeoutMs: input.timeoutMs,
            config: sanitizedConfig,
          }));
        }
      }
      throw new Error("Sandbox driver does not support direct command execution for built-in providers.");
    },

    async destroyRunLease(input) {
      return await destroyReusableSandboxLease({
        environment: input.environment,
        lease: input.lease,
        failureReason: input.failureReason ?? "lease_destroyed",
        cleanupClaimId: input.cleanupClaimId,
      });
    },
  };

  async function releasePluginBackedSandboxLease(
    input: EnvironmentDriverReleaseInput,
    failureReason?: string,
    leaseMetadata = input.lease.metadata ?? undefined,
  ): Promise<EnvironmentLease | null> {
    const metadata = input.lease.metadata ?? {};
    const pluginId = readString(metadata.pluginId);
    const providerKey = readString(metadata.provider);

    let cleanupError: unknown | null = null;
    if (pluginId && providerKey && pluginWorkerManager?.isRunning(pluginId)) {
      try {
        const config = await resolveSandboxRuntimeConfig({
          environment: input.environment,
          lease: input.lease,
          provider: providerKey,
        });
        await pluginWorkerManager.call(pluginId, "environmentReleaseLease", {
          driverKey: providerKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
          ...acquisitionIdentityParams(metadata),
          providerLeaseId: input.lease.providerLeaseId,
          leaseMetadata,
        }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
      } catch (error) {
        cleanupError = error;
      }
    } else {
      cleanupError = new Error("Sandbox provider plugin worker is unavailable");
    }

    if (isProviderLeaseIdentityMissingCleanupError(cleanupError)) {
      const released = await environmentsSvc.releaseLease(input.lease.id, "failed", {
        failureReason: PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON,
        cleanupStatus: "failed",
        expectedCleanupClaimId: input.cleanupClaimId,
        expectedStatus: "pending_cleanup",
      });
      if (released) clearSandboxRuntimeConfig(input.lease.id);
      return released;
    }

    return await finalizeSandboxRelease({
      release: input,
      cleanupError,
      failureReason,
    });
  }

  async function claimReusableSandboxLeaseForCleanup(
    lease: EnvironmentLease,
    expectedAdoptionClaimId?: string,
  ): Promise<{ lease: EnvironmentLease; cleanupClaimId: string } | null> {
    if (!lease.provider || !lease.providerLeaseId) return null;

    const cleanupClaimId = randomUUID();
    const row = await db
      .update(environmentLeases)
      .set({
        status: "pending_cleanup",
        cleanupClaimId,
        cleanupClaimedAt: new Date(),
        reusableAdoptionClaimId: null,
        metadata: sql<Record<string, unknown>>`
          coalesce(${environmentLeases.metadata}, '{}'::jsonb)
          || ${JSON.stringify({
            [PENDING_CLEANUP_RELEASE_STATUS_KEY]: "expired",
          })}::jsonb
        `,
      })
      .where(and(
        eq(environmentLeases.id, lease.id),
        eq(environmentLeases.companyId, lease.companyId),
        eq(environmentLeases.environmentId, lease.environmentId),
        eq(environmentLeases.provider, lease.provider),
        eq(environmentLeases.status, lease.status),
        eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
        eq(environmentLeases.reusableResourceOwner, true),
        expectedAdoptionClaimId
          ? eq(environmentLeases.reusableAdoptionClaimId, expectedAdoptionClaimId)
          : isNull(environmentLeases.reusableAdoptionClaimId),
        isNull(environmentLeases.cleanupClaimId),
        sql`${environmentLeases.failureReason}
          is distinct from ${PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON}`,
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row
      ? { lease: toEnvironmentLeaseSnapshot(row), cleanupClaimId }
      : null;
  }

  async function destroyReusableSandboxLease(input: {
    environment: Environment;
    lease: EnvironmentLease;
    failureReason: string;
    cleanupClaimId?: string;
    cleanupMetadata?: Record<string, unknown>;
  }): Promise<EnvironmentLease | null> {
    let lease = input.lease;
    let cleanupClaimId = input.cleanupClaimId;
    if (!cleanupClaimId) {
      const claimed = await claimReusableSandboxLeaseForCleanup(lease);
      if (!claimed) return null;
      lease = claimed.lease;
      cleanupClaimId = claimed.cleanupClaimId;
    }

    const metadata = input.cleanupMetadata ?? lease.metadata ?? {};
    let cleanupError: unknown | null = null;
    const cleanupStillOwned = async () => await db
      .select({ id: environmentLeases.id })
      .from(environmentLeases)
      .where(and(
        eq(environmentLeases.id, lease.id),
        eq(environmentLeases.companyId, lease.companyId),
        eq(environmentLeases.environmentId, lease.environmentId),
        eq(environmentLeases.provider, lease.provider!),
        eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
        eq(environmentLeases.status, "pending_cleanup"),
        eq(environmentLeases.cleanupClaimId, cleanupClaimId),
        eq(environmentLeases.reusableResourceOwner, true),
        isNull(environmentLeases.reusableAdoptionClaimId),
      ))
      .then((rows) => Boolean(rows[0]));

    try {
      if (metadata.sandboxProviderPlugin) {
        const pluginId = readString(metadata.pluginId);
        const providerKey = readString(metadata.provider);
        if (!pluginId || !providerKey || !pluginWorkerManager?.isRunning(pluginId)) {
          throw new Error("Sandbox provider plugin worker is unavailable");
        } else {
          const config = await resolveSandboxRuntimeConfig({
            environment: input.environment,
            lease,
            provider: providerKey,
          });
          if (!await cleanupStillOwned()) return null;
          await pluginWorkerManager.call(pluginId, "environmentDestroyLease", {
            driverKey: providerKey,
            companyId: lease.companyId,
            environmentId: input.environment.id,
            issueId: lease.issueId,
            config: stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig),
            ...acquisitionIdentityParams(metadata),
            providerLeaseId: lease.providerLeaseId,
            leaseMetadata: metadata,
          }, resolvePluginSandboxRpcTimeoutMs(stripSandboxProviderEnvelope(config as SandboxEnvironmentConfig)));
        }
      } else {
        const providerKey = readString(metadata.provider);
        if (!providerKey) throw new Error(`Sandbox lease "${lease.id}" has no provider.`);
        const config = await resolveSandboxRuntimeConfig({
          environment: input.environment,
          lease,
          provider: providerKey,
        });
        if (!await cleanupStillOwned()) return null;
        await destroySandboxProviderLease({
          config: config as unknown as SandboxEnvironmentConfig,
          providerLeaseId: lease.providerLeaseId,
        });
      }
    } catch (error) {
      cleanupError = error;
    }

    if (isProviderLeaseIdentityMissingCleanupError(cleanupError)) {
      const released = await environmentsSvc.releaseLease(lease.id, "failed", {
        failureReason: PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON,
        cleanupStatus: "failed",
        expectedCleanupClaimId: cleanupClaimId,
        expectedStatus: "pending_cleanup",
      });
      if (released) clearSandboxRuntimeConfig(lease.id);
      return released;
    }

    return await finalizeSandboxRelease({
      release: {
        environment: input.environment,
        lease,
        status: "expired",
        cleanupClaimId,
      },
      cleanupError,
      deleteBindings: true,
      failureReason: input.failureReason,
    });
  }
}

function parseExpiresAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pluginDriverProviderKey(config: PluginEnvironmentConfig): string {
  return `${config.pluginKey}:${config.driverKey}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPersistedAcquisitionId(metadata: Record<string, unknown> | null | undefined): string | null {
  return readString(metadata?.[SANDBOX_ACQUISITION_ID_KEY])
    ?? readString(metadata?.acquisitionId);
}

function acquisitionIdentityParams(
  metadata: Record<string, unknown> | null | undefined,
): { acquisitionId?: string } {
  const acquisitionId = readPersistedAcquisitionId(metadata);
  return acquisitionId ? { acquisitionId } : {};
}

function verifiedCleanupMetadata(
  error: unknown,
  lease: Pick<EnvironmentLease, "metadata" | "providerLeaseId">,
): Record<string, string> {
  const errorData = readPluginAcquireLeaseErrorData(error);
  const acquisitionId = readPersistedAcquisitionId(lease.metadata);
  return errorData?.providerLeaseId === lease.providerLeaseId
    && errorData.cleanupVerifiedAcquisitionId === acquisitionId
    && acquisitionId
    ? { [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId }
    : {};
}

function readSandboxCustomImageReplay(value: unknown): SandboxCustomImageReplay | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.set) || !Array.isArray(value.unset)) {
    return null;
  }
  const setFields = Object.keys(value.set);
  if (!setFields.every(isSafeSandboxReplayConfigField)) return null;
  if (!value.unset.every((field): field is string =>
    typeof field === "string" && isSafeSandboxReplayConfigField(field)
  )) {
    return null;
  }
  if (new Set(value.unset).size !== value.unset.length) return null;
  const unsetFields = new Set(value.unset);
  if (setFields.some((field) => unsetFields.has(field))) return null;
  return {
    version: 1,
    set: value.set,
    unset: value.unset,
  };
}

function readSandboxAcquisitionContext(lease: EnvironmentLease): SandboxAcquisitionContext | null {
  const value = lease.metadata?.[SANDBOX_ACQUISITION_CONTEXT_KEY];
  if (!isRecord(value) || value.version !== 1) return null;
  if (value.kind !== "builtin" && value.kind !== "plugin") return null;
  const provider = readString(value.provider);
  const config = isRecord(value.config) ? value.config : null;
  const runId = readString(value.runId);
  if (!provider || !config || !runId) return null;

  const pluginId = readString(value.pluginId) ?? undefined;
  const pluginKey = readString(value.pluginKey) ?? undefined;
  const pluginPackageName = readString(value.pluginPackageName) ?? undefined;
  const pluginVersion = readString(value.pluginVersion) ?? undefined;
  const pluginSupportsAcquisitionReplay = typeof value.pluginSupportsAcquisitionReplay === "boolean"
    ? value.pluginSupportsAcquisitionReplay
    : undefined;
  if (value.kind === "plugin" && (!pluginId || !pluginKey)) return null;
  const hasCustomImageReplay = Object.prototype.hasOwnProperty.call(value, "customImageReplay");
  const customImageReplay = hasCustomImageReplay && value.customImageReplay !== null
    ? readSandboxCustomImageReplay(value.customImageReplay)
    : null;
  if (hasCustomImageReplay && value.customImageReplay !== null && !customImageReplay) return null;

  return {
    version: 1,
    kind: value.kind,
    provider,
    pluginId,
    pluginKey,
    pluginPackageName,
    pluginVersion,
    pluginSupportsAcquisitionReplay,
    config,
    runId,
    workspaceMode: readString(value.workspaceMode),
    agentId: readString(value.agentId),
    executionWorkspaceId: readString(value.executionWorkspaceId),
    adapterType: readString(value.adapterType),
    applyCustomImageTemplate: value.applyCustomImageTemplate === true,
    ...(hasCustomImageReplay ? { customImageReplay } : {}),
    reusableProviderLeaseId: readString(value.reusableProviderLeaseId),
    leaseFingerprint: isRecord(value.leaseFingerprint) ? value.leaseFingerprint : null,
  };
}

const INTERNAL_PLUGIN_SANDBOX_CONFIG_KEYS = new Set([
  "agentId",
  "acquisitionId",
  "driver",
  "executionWorkspaceMode",
  LEASE_SCOPED_SECRET_BINDINGS_KEY,
  PENDING_CLEANUP_RELEASE_STATUS_KEY,
  PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY,
  SANDBOX_LEASE_RESERVATION_KEY,
  "pluginId",
  "pluginKey",
  "providerMetadata",
  PLUGIN_SANDBOX_PROVIDER_CONFIG_KEY,
  SANDBOX_ACQUISITION_CONTEXT_KEY,
  SANDBOX_ACQUISITION_ID_KEY,
  "sandboxProviderPlugin",
  "reusableSandboxLease",
  "workspaceRealization",
]);

function sanitizePluginSandboxConfigFromLeaseMetadata(
  metadata: object | null | undefined,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (INTERNAL_PLUGIN_SANDBOX_CONFIG_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

function sandboxConfigForLeaseMetadata(config: SandboxEnvironmentConfig): Record<string, unknown> {
  return structuredClone(config as unknown as Record<string, unknown>);
}

function tryParseCurrentPluginConfig(environment: Environment): PluginEnvironmentConfig | null {
  if (environment.driver !== "plugin") {
    return null;
  }
  try {
    const parsed = parseEnvironmentDriverConfig(environment);
    return parsed.driver === "plugin" ? parsed.config : null;
  } catch {
    return null;
  }
}

function createPluginEnvironmentDriver(
  db: Db,
  workerManager: PluginWorkerManager,
): EnvironmentRuntimeDriver {
  const environmentsSvc = environmentService(db);
  const pluginRegistry = pluginRegistryService(db);

  async function resolvePluginDriver(config: PluginEnvironmentConfig) {
    const plugin = await pluginRegistry.getByKey(config.pluginKey);
    if (!plugin || plugin.status !== "ready") {
      throw new Error(`Plugin environment driver "${pluginDriverProviderKey(config)}" is not ready.`);
    }
    const driver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === config.driverKey,
    );
    if (!driver) {
      throw new Error(`Plugin "${config.pluginKey}" does not declare environment driver "${config.driverKey}".`);
    }
    if (!workerManager.isRunning(plugin.id)) {
      throw new Error(`Plugin environment driver "${pluginDriverProviderKey(config)}" has no running worker.`);
    }
    return { plugin };
  }

  async function resolvePluginDriverForRelease(input: EnvironmentDriverReleaseInput) {
    const metadata = input.lease.metadata ?? {};
    const metadataPluginId = readString(metadata.pluginId);
    const metadataPluginKey = readString(metadata.pluginKey);
    const metadataDriverKey = readString(metadata.driverKey);
    const currentConfig = tryParseCurrentPluginConfig(input.environment);

    if (!metadataPluginId && !metadataPluginKey && !metadataDriverKey) {
      if (!currentConfig) {
        throw new Error(`Expected plugin environment config for driver "${input.environment.driver}".`);
      }
      const { plugin } = await resolvePluginDriver(currentConfig);
      return {
        plugin,
        pluginKey: currentConfig.pluginKey,
        driverKey: currentConfig.driverKey,
        driverConfig: currentConfig.driverConfig,
      };
    }

    const plugin = metadataPluginId
      ? await pluginRegistry.getById(metadataPluginId)
      : metadataPluginKey
        ? await pluginRegistry.getByKey(metadataPluginKey)
        : currentConfig
          ? await pluginRegistry.getByKey(currentConfig.pluginKey)
          : null;
    const driverKey = metadataDriverKey ?? currentConfig?.driverKey;
    const pluginKey = metadataPluginKey ?? plugin?.pluginKey ?? currentConfig?.pluginKey ?? "unknown";

    if (!driverKey) {
      throw new Error(`Plugin environment driver "${pluginKey}:unknown" is missing a driver key.`);
    }

    if (!plugin || plugin.status !== "ready") {
      throw new Error(`Plugin environment driver "${pluginKey}:${driverKey}" is not ready.`);
    }
    const declaredDriver = plugin.manifestJson.environmentDrivers?.find(
      (candidate) => candidate.driverKey === driverKey,
    );
    if (!declaredDriver) {
      throw new Error(`Plugin "${plugin.pluginKey}" does not declare environment driver "${driverKey}".`);
    }
    if (!workerManager.isRunning(plugin.id)) {
      throw new Error(`Plugin environment driver "${plugin.pluginKey}:${driverKey}" has no running worker.`);
    }

    const currentConfigStillMatches =
      currentConfig?.pluginKey === plugin.pluginKey && currentConfig.driverKey === driverKey;

    return {
      plugin,
      pluginKey: plugin.pluginKey,
      driverKey,
      driverConfig: currentConfigStillMatches ? currentConfig.driverConfig : {},
    };
  }

  return {
    driver: "plugin",

    async acquireRunLease(input) {
      const parsed = parseEnvironmentDriverConfig(input.environment);
      if (parsed.driver !== "plugin") {
        throw new Error(`Expected plugin environment config for driver "${input.environment.driver}".`);
      }
      const { plugin } = await resolvePluginDriver(parsed.config);
      const acquisitionId = randomUUID();
      let providerLease: PluginEnvironmentLease;
      try {
        providerLease = await workerManager.call(plugin.id, "environmentAcquireLease", {
          acquisitionId,
          driverKey: parsed.config.driverKey,
          companyId: input.companyId,
          environmentId: input.environment.id,
          issueId: input.issueId,
          config: parsed.config.driverConfig,
          runId: input.heartbeatRunId ?? acquisitionId,
          workspaceMode: input.executionWorkspaceMode ?? undefined,
          agentId: input.agentId ?? undefined,
          executionWorkspaceId: input.executionWorkspaceId ?? undefined,
          adapterType: input.adapterType ?? undefined,
        });
      } catch (error) {
        const errorData = readPluginAcquireLeaseErrorData(error);
        if (!errorData) throw error;

        const cleanupMetadata = {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          providerMetadata: {},
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          pluginId: plugin.id,
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
          acquisitionId,
          ...(errorData.cleanupVerifiedAcquisitionId === acquisitionId
            ? { [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId }
            : {}),
        };
        let cleanupLease: EnvironmentLease | null = null;
        let cleanupError: unknown | null = null;
        try {
          cleanupLease = await environmentsSvc.acquireLease({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            issueId: input.issueId,
            heartbeatRunId: input.heartbeatRunId,
            leasePolicy: "ephemeral",
            provider: `plugin:${parsed.config.pluginKey}:${parsed.config.driverKey}`,
            providerLeaseId: errorData.providerLeaseId,
            metadata: cleanupMetadata,
          });
        } catch (error) {
          cleanupError = error;
        }

        try {
          await workerManager.call(plugin.id, "environmentReleaseLease", {
            driverKey: parsed.config.driverKey,
            companyId: input.companyId,
            environmentId: input.environment.id,
            issueId: input.issueId,
            config: parsed.config.driverConfig,
            acquisitionId,
            providerLeaseId: errorData.providerLeaseId,
            leaseMetadata: withoutCleanupVerification(cleanupMetadata),
          });
          cleanupError = null;
          if (cleanupLease) {
            await environmentsSvc.releaseLease(cleanupLease.id, "expired", {
              cleanupStatus: "success",
            });
          }
        } catch (error) {
          cleanupError = error;
          if (cleanupLease) {
            await environmentsSvc.releaseLease(cleanupLease.id, "pending_cleanup", {
              failureReason: "acquire_handoff_failed",
              cleanupStatus: "failed",
              expectedStatus: "active",
              metadata: {
                ...(cleanupLease.metadata ?? {}),
                ...verifiedCleanupMetadata(cleanupError, cleanupLease),
                [PENDING_CLEANUP_RELEASE_STATUS_KEY]: "expired",
              },
            }).catch(() => null);
          }
        }
        if (cleanupError) {
          logger.error(
            {
              err: cleanupError,
              environmentId: input.environment.id,
              providerLeaseId: errorData.providerLeaseId,
            },
            "failed to compensate plugin environment lease after acquisition failure",
          );
        }
        throw error;
      }

      return await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: input.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: `plugin:${parsed.config.pluginKey}:${parsed.config.driverKey}`,
        providerLeaseId: providerLease.providerLeaseId,
        expiresAt: parseExpiresAt(providerLease.expiresAt),
        metadata: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          providerMetadata: providerLease.metadata ?? {},
          driver: input.environment.driver,
          executionWorkspaceMode: input.executionWorkspaceMode,
          pluginId: plugin.id,
          pluginKey: parsed.config.pluginKey,
          driverKey: parsed.config.driverKey,
          acquisitionId,
        },
      });
    },

    async releaseRunLease(input) {
      const { plugin, driverKey, driverConfig } = await resolvePluginDriverForRelease(input);
      await workerManager.call(plugin.id, "environmentReleaseLease", {
        driverKey,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: driverConfig,
        ...acquisitionIdentityParams(input.lease.metadata),
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
      return await environmentsSvc.releaseLease(input.lease.id, input.status, {
        expectedCleanupClaimId: input.cleanupClaimId,
        expectedStatus: input.cleanupClaimId ? "pending_cleanup" : input.lease.status,
      });
    },

    async resumeRunLease(input) {
      if (!input.lease.providerLeaseId) {
        throw new Error(`Plugin environment lease "${input.lease.id}" does not have a provider lease id to resume.`);
      }
      const { pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        ...input,
        status: "released",
      });
      return await resumePluginEnvironmentLease({
        db,
        workerManager,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        ...acquisitionIdentityParams(input.lease.metadata),
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
    },

    async destroyRunLease(input) {
      const { pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        ...input,
        status: "failed",
      });
      await destroyPluginEnvironmentLease({
        db,
        workerManager,
        companyId: input.lease.companyId,
        environmentId: input.environment.id,
        issueId: input.lease.issueId,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        ...acquisitionIdentityParams(input.lease.metadata),
        providerLeaseId: input.lease.providerLeaseId,
        leaseMetadata: input.lease.metadata ?? undefined,
      });
      return await environmentsSvc.releaseLease(input.lease.id, "failed", {
        failureReason: input.failureReason ?? "lease_destroyed",
      });
    },

    async realizeWorkspace(input) {
      const { plugin, pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        environment: input.environment,
        lease: input.lease,
        status: "released",
      });
      const result = await realizePluginEnvironmentWorkspace({
        db,
        workerManager,
        pluginId: plugin.id,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        params: {
          driverKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: driverConfig,
          lease: {
            providerLeaseId: input.lease.providerLeaseId,
            metadata: input.lease.metadata ?? undefined,
            expiresAt: input.lease.expiresAt?.toISOString() ?? null,
          },
          env: input.env,
          workspace: input.workspace,
        },
      });
      if (!result) {
        return { cwd: "" };
      }
      const record = buildWorkspaceRealizationRecordFromDriverInput({
        environment: input.environment,
        lease: input.lease,
        workspace: input.workspace,
        cwd: result.cwd,
        providerMetadata: result.metadata,
        credentialOwnerAgentId: resolveRealizationCredentialOwnerAgentId(input),
        forwardedCredentialValues: resolveForwardedCredentialValues(input),
      });
      return {
        ...result,
        metadata: {
          ...result.metadata,
          workspaceRealization: record,
        },
      };
    },

    async execute(input) {
      const { plugin, pluginKey, driverKey, driverConfig } = await resolvePluginDriverForRelease({
        environment: input.environment,
        lease: input.lease,
        status: "released",
      });
      return await executePluginEnvironmentCommand({
        db,
        workerManager,
        pluginId: plugin.id,
        config: {
          pluginKey,
          driverKey,
          driverConfig,
        },
        params: {
          driverKey,
          companyId: input.lease.companyId,
          environmentId: input.environment.id,
          issueId: input.lease.issueId,
          config: driverConfig,
          lease: {
            providerLeaseId: input.lease.providerLeaseId,
            metadata: input.lease.metadata ?? undefined,
            expiresAt: input.lease.expiresAt?.toISOString() ?? null,
          },
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env,
          stdin: input.stdin,
          timeoutMs: input.timeoutMs,
          ...(input.workspaceRealization
            ? { workspaceRealization: input.workspaceRealization }
            : {}),
        },
      });
    },
  };
}

export function environmentRuntimeService(
  db: Db,
  options: {
    drivers?: EnvironmentRuntimeDriver[];
    pluginWorkerManager?: PluginWorkerManager;
    pluginWorkerReadyTimeoutMs?: number;
    pluginWorkerReadyPollMs?: number;
    toolActionSigningSecret?: string;
  } = {},
) {
  const environmentsSvc = environmentService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const runtimeStartedAt = new Date();
  const drivers = new Map<string, EnvironmentRuntimeDriver>();

  const defaultDrivers = [
    createLocalEnvironmentDriver(db),
    createSshEnvironmentDriver(db),
    createSandboxEnvironmentDriver(db, {
      pluginWorkerManager: options.pluginWorkerManager,
      pluginWorkerReadyTimeoutMs: options.pluginWorkerReadyTimeoutMs,
      pluginWorkerReadyPollMs: options.pluginWorkerReadyPollMs,
      claimPendingCleanup: claimPendingSandboxCleanup,
      renewPendingCleanupClaim: renewPendingSandboxCleanupClaim,
      deferCleanupClaim: deferSandboxCleanupClaim,
    }),
    ...(options.pluginWorkerManager
      ? [createPluginEnvironmentDriver(db, options.pluginWorkerManager)]
      : []),
  ];

  for (const driver of options.drivers ?? defaultDrivers) {
    drivers.set(driver.driver, driver);
  }

  function getDriver(driverKey: string): EnvironmentRuntimeDriver | null {
    return drivers.get(driverKey) ?? null;
  }

  function requireDriver(environment: Pick<Environment, "driver">): EnvironmentRuntimeDriver {
    const driver = getDriver(environment.driver);
    if (!driver) {
      throw new Error(
        `Environment driver "${environment.driver}" is not registered in the environment runtime yet.`,
      );
    }
    return driver;
  }

  function requireDriverKey(driverKey: string): EnvironmentRuntimeDriver {
    const driver = getDriver(driverKey);
    if (!driver) {
      throw new Error(
        `Environment driver "${driverKey}" is not registered in the environment runtime yet.`,
      );
    }
    return driver;
  }

  function terminalWorkspaceReconciliationEligibility(input: {
    companyId: string;
    executionWorkspaceId: string;
  }) {
    return sql`exists (
      select 1 from ${executionWorkspaces}
      where ${executionWorkspaces.id} = ${input.executionWorkspaceId}
        and ${executionWorkspaces.companyId} = ${input.companyId}
        and ${executionWorkspaces.status} = 'cleanup_failed'
        and exists (
          select 1 from ${issues}
          where ${issues.companyId} = ${executionWorkspaces.companyId}
            and (${issues.id} = ${executionWorkspaces.sourceIssueId}
              or ${issues.executionWorkspaceId} = ${executionWorkspaces.id})
            and ${issues.status} in ('done', 'cancelled')
        )
        and not exists (
          select 1 from ${issues}
          where ${issues.companyId} = ${executionWorkspaces.companyId}
            and (${issues.id} = ${executionWorkspaces.sourceIssueId}
              or ${issues.executionWorkspaceId} = ${executionWorkspaces.id})
            and ${issues.status} not in ('done', 'cancelled')
        )
        and not exists (
          select 1 from ${heartbeatRuns}
          where ${heartbeatRuns.companyId} = ${executionWorkspaces.companyId}
            and ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')
            and ${heartbeatRuns.contextSnapshot} ->> 'executionWorkspaceId' = ${executionWorkspaces.id}::text
        )
    ) and not exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.id} = ${environmentLeases.heartbeatRunId}
        and ${heartbeatRuns.companyId} = ${input.companyId}
        and ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')
    )`;
  }

  async function destroyReusableSandboxLeases(input: {
    companyId: string;
    issueId?: string | null;
    executionWorkspaceId?: string | null;
    failureReason?: string;
    terminalWorkspaceReconciliation?: {
      executionWorkspaceId: string;
    };
  }): Promise<EnvironmentRuntimeLeaseRecord[]> {
    const scopeConditions = [
      input.issueId ? eq(environmentLeases.issueId, input.issueId) : undefined,
      input.executionWorkspaceId ? eq(environmentLeases.executionWorkspaceId, input.executionWorkspaceId) : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
    if (scopeConditions.length === 0) return [];

    const leaseRows = await db
      .select()
      .from(environmentLeases)
      .where(
        and(
          eq(environmentLeases.companyId, input.companyId),
          eq(environmentLeases.leasePolicy, "reuse_by_environment"),
          inArray(environmentLeases.status, ["active", "released", "retained", "failed", "pending_cleanup"]),
          isReusableEnvironmentLeaseDestroyRequestCandidate(),
          ...scopeConditions,
        ),
      );

    const destroyed: EnvironmentRuntimeLeaseRecord[] = [];
    for (const leaseRow of leaseRows) {
      let claim = await claimSandboxCleanup({
        leaseId: leaseRow.id,
        expectedStatus: leaseRow.status as EnvironmentLeaseStatus,
        targetStatus: "expired",
        requireAuthoritativeReusableLease: true,
        terminalWorkspaceReconciliation: input.terminalWorkspaceReconciliation
          ? {
              companyId: input.companyId,
              executionWorkspaceId: input.terminalWorkspaceReconciliation.executionWorkspaceId,
            }
          : undefined,
      });
      if (!claim) {
        const destroyRequest = await requestReusableSandboxCleanup(
          leaseRow.id,
          "expired",
          input.failureReason ?? "reusable_lease_destroyed",
          input.terminalWorkspaceReconciliation
            ? {
                companyId: input.companyId,
                executionWorkspaceId: input.terminalWorkspaceReconciliation.executionWorkspaceId,
              }
            : undefined,
        );
        if (!destroyRequest) continue;
        claim = destroyRequest.claimId
          ? { claimId: destroyRequest.claimId, row: destroyRequest.row }
          : await claimPendingSandboxCleanup({
              leaseId: destroyRequest.row.id,
              requireAuthoritativeReusableLease: true,
            });
        if (!claim) continue;
      }
      const claimRenewal = renewPendingSandboxCleanupClaim(claim.row.id, claim.claimId);
      let environment: Environment | null = null;
      let leaseSnapshot: EnvironmentLease | null = null;
      let lease: EnvironmentLease | null = null;
      try {
        environment = await environmentsSvc.getById(claim.row.environmentId);
        leaseSnapshot = toEnvironmentLeaseSnapshot(claim.row);
        const driver = environment
          ? getDriver(getLeaseDriverKey(leaseSnapshot, environment))
          : null;
        if (!environment || !driver) {
          await deferSandboxCleanupClaim(
            claim,
            environment ? "environment_driver_unavailable" : "environment_unavailable",
          );
          continue;
        }
        lease = driver.destroyRunLease
          ? await driver.destroyRunLease({
              environment,
              lease: leaseSnapshot,
              failureReason: input.failureReason ?? "reusable_lease_destroyed",
              cleanupClaimId: claim.claimId,
            })
          : await environmentsSvc.releaseLease(leaseSnapshot.id, "pending_cleanup", {
              failureReason: input.failureReason ?? "reusable_lease_destroyed",
              cleanupStatus: "failed",
              expectedCleanupClaimId: claim.claimId,
              expectedStatus: "pending_cleanup",
            });
      } catch (error) {
        await deferSandboxCleanupClaim(
          claim,
          leaseSnapshot?.failureReason ?? input.failureReason ?? "reusable_lease_destroy_failed",
        );
        logger.warn(
          { err: error, leaseId: claim.row.id, environmentId: claim.row.environmentId },
          "reusable environment lease destroy failed",
        );
        continue;
      } finally {
        clearInterval(claimRenewal);
      }
      if (!environment || !lease) continue;
      destroyed.push({
        environment,
        lease,
        leaseContext: {
          executionWorkspaceId: lease.executionWorkspaceId,
          executionWorkspaceMode:
            (lease.metadata?.executionWorkspaceMode as ExecutionWorkspace["mode"] | null | undefined) ?? null,
        },
      });
    }
    return destroyed;
  }

  async function reconcileTerminalExecutionWorkspaces() {
    const candidates = await db
      .select({
        companyId: executionWorkspaces.companyId,
        executionWorkspaceId: executionWorkspaces.id,
        status: executionWorkspaces.status,
      })
      .from(executionWorkspaces)
      .where(and(
        or(
          and(
            eq(executionWorkspaces.status, "active"),
            sql`exists (
              select 1 from ${issues}
              where ${issues.companyId} = ${executionWorkspaces.companyId}
                and (${issues.id} = ${executionWorkspaces.sourceIssueId}
                  or ${issues.executionWorkspaceId} = ${executionWorkspaces.id})
                and ${issues.status} in ('done', 'cancelled')
            )`,
            sql`not exists (
              select 1 from ${issues}
              where ${issues.companyId} = ${executionWorkspaces.companyId}
                and (${issues.id} = ${executionWorkspaces.sourceIssueId}
                  or ${issues.executionWorkspaceId} = ${executionWorkspaces.id})
                and ${issues.status} not in ('done', 'cancelled')
            )`,
            sql`not exists (
              select 1 from ${heartbeatRuns}
              where ${heartbeatRuns.companyId} = ${executionWorkspaces.companyId}
                and ${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')
                and ${heartbeatRuns.contextSnapshot} ->> 'executionWorkspaceId' = ${executionWorkspaces.id}::text
            )`,
          ),
          and(
            eq(executionWorkspaces.status, "cleanup_failed"),
            eq(executionWorkspaces.cleanupReason, "terminal_issue_workspace_reconciliation"),
          ),
        ),
        sql`not exists (
          select 1 from ${environmentLeases}
          where ${environmentLeases.companyId} = ${executionWorkspaces.companyId}
            and ${environmentLeases.executionWorkspaceId} = ${executionWorkspaces.id}
            and ${environmentLeases.leasePolicy} = 'reuse_by_environment'
            and ${environmentLeases.status} = 'pending_cleanup'
            and ${isAutomaticReusableEnvironmentLeaseCleanupCandidate()}
        )`,
      ))
      .orderBy(asc(executionWorkspaces.updatedAt))
      .limit(SANDBOX_CLEANUP_RETRY_BATCH_SIZE);

    for (const candidate of candidates) {
      try {
        if (candidate.status === "cleanup_failed") {
          const settledWorkspace = await executionWorkspacesSvc.markIdleAfterTerminalIssueCleanup(candidate);
          if (settledWorkspace) continue;
        } else {
          const claimedWorkspace = await executionWorkspacesSvc.claimTerminalIssueCleanup(candidate);
          if (!claimedWorkspace) continue;
        }
        await destroyReusableSandboxLeases({
          ...candidate,
          failureReason: "terminal_issue_workspace_reconciliation",
          terminalWorkspaceReconciliation: {
            executionWorkspaceId: candidate.executionWorkspaceId,
          },
        });
        await executionWorkspacesSvc.markIdleAfterTerminalIssueCleanup(candidate);
      } catch (error) {
        logger.warn(
          { err: error, executionWorkspaceId: candidate.executionWorkspaceId },
          "failed to recover terminal issue execution workspace",
        );
      }
    }
  }

  async function claimSandboxCleanup(input: {
    leaseId: string;
    expectedStatus: EnvironmentLeaseStatus;
    targetStatus?: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed">;
    updatedBefore?: Date;
    requireAuthoritativeReusableLease?: boolean;
    terminalWorkspaceReconciliation?: {
      companyId: string;
      executionWorkspaceId: string;
    };
  }) {
    const claimId = randomUUID();
    const claimStaleBefore = new Date(Date.now() - SANDBOX_CLEANUP_CLAIM_STALE_MS);
    const row = await db
      .update(environmentLeases)
      .set({
        status: "pending_cleanup",
        cleanupClaimId: claimId,
        cleanupClaimedAt: new Date(),
        ...(input.targetStatus
          ? {
              metadata: sql<Record<string, unknown>>`
                coalesce(${environmentLeases.metadata}, '{}'::jsonb)
                || ${JSON.stringify({
                  [PENDING_CLEANUP_RELEASE_STATUS_KEY]: input.targetStatus,
                })}::jsonb
              `,
            }
          : {}),
      })
      .where(
        and(
          eq(environmentLeases.id, input.leaseId),
          eq(environmentLeases.status, input.expectedStatus),
          input.updatedBefore ? lte(environmentLeases.updatedAt, input.updatedBefore) : undefined,
          input.requireAuthoritativeReusableLease
            ? isAutomaticReusableEnvironmentLeaseCleanupCandidate()
            : undefined,
          input.terminalWorkspaceReconciliation
            ? terminalWorkspaceReconciliationEligibility(input.terminalWorkspaceReconciliation)
            : undefined,
          or(
            isNull(environmentLeases.cleanupClaimedAt),
            lte(environmentLeases.cleanupClaimedAt, claimStaleBefore),
          ),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? { claimId, row } : null;
  }

  async function deferSandboxCleanupClaim(
    claim: { claimId: string; row: typeof environmentLeases.$inferSelect },
    failureReason: string,
  ) {
    return await environmentsSvc.releaseLease(claim.row.id, "pending_cleanup", {
      failureReason,
      cleanupStatus: "failed",
      expectedCleanupClaimId: claim.claimId,
      expectedStatus: "pending_cleanup",
    });
  }

  async function requestReusableSandboxCleanup(
    leaseId: string,
    targetStatus: Extract<EnvironmentLeaseStatus, "released" | "expired">,
    failureReason?: string,
    terminalWorkspaceReconciliation?: {
      companyId: string;
      executionWorkspaceId: string;
    },
  ) {
    const claimId = randomUUID();
    const claimedAt = new Date();
    const row = await db
      .update(environmentLeases)
      .set({
        status: "pending_cleanup",
        cleanupClaimId: sql`
          case
            when ${environmentLeases.reusableAdoptionClaimId} is not null
              then ${environmentLeases.cleanupClaimId}
            when ${environmentLeases.status} = 'pending_cleanup' then ${environmentLeases.cleanupClaimId}
            else ${claimId}
          end
        `,
        cleanupClaimedAt: sql`
          case
            when ${environmentLeases.reusableAdoptionClaimId} is not null
              then ${environmentLeases.cleanupClaimedAt}
            when ${environmentLeases.status} = 'pending_cleanup' then ${environmentLeases.cleanupClaimedAt}
            else ${claimedAt.toISOString()}::timestamptz
          end
        `,
        ...(failureReason !== undefined ? { failureReason } : {}),
        updatedAt: claimedAt,
        metadata: sql<Record<string, unknown>>`
          coalesce(${environmentLeases.metadata}, '{}'::jsonb)
          || ${JSON.stringify({
            [PENDING_CLEANUP_RELEASE_STATUS_KEY]: targetStatus,
          })}::jsonb
        `,
      })
      .where(and(
        eq(environmentLeases.id, leaseId),
        eq(environmentLeases.leasePolicy, "reuse_by_environment"),
        inArray(environmentLeases.status, ["active", "released", "retained", "failed", "pending_cleanup"]),
        isReusableEnvironmentLeaseDestroyRequestCandidate(),
        terminalWorkspaceReconciliation
          ? terminalWorkspaceReconciliationEligibility(terminalWorkspaceReconciliation)
          : undefined,
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      claimId: row.cleanupClaimId === claimId ? claimId : null,
      row,
    };
  }

  async function claimPendingSandboxCleanup(input: {
    leaseId: string;
    updatedBefore?: Date;
    requireAuthoritativeReusableLease?: boolean;
  }) {
    return await claimSandboxCleanup({
      ...input,
      expectedStatus: "pending_cleanup",
    });
  }

  async function promoteStaleSandboxAcquisitionReservations(updatedBefore: Date) {
    const staleRows = await db
      .select({ lease: environmentLeases })
      .from(environmentLeases)
      .leftJoin(heartbeatRuns, eq(environmentLeases.heartbeatRunId, heartbeatRuns.id))
      .where(and(
        eq(environmentLeases.status, "active"),
        isNull(environmentLeases.providerLeaseId),
        lte(environmentLeases.updatedAt, updatedBefore),
        sql`${environmentLeases.metadata} ->> ${SANDBOX_LEASE_RESERVATION_KEY} = 'true'`,
        sql`${environmentLeases.metadata} ->> ${SANDBOX_ACQUISITION_ID_KEY} = ${environmentLeases.id}::text`,
        or(
          and(
            isNull(environmentLeases.heartbeatRunId),
            lt(environmentLeases.updatedAt, runtimeStartedAt),
          ),
          and(isNotNull(environmentLeases.heartbeatRunId), isNull(heartbeatRuns.id)),
          inArray(heartbeatRuns.status, ["succeeded", "interrupted", "failed", "cancelled", "timed_out"]),
        ),
      ))
      .orderBy(asc(environmentLeases.updatedAt))
      .limit(SANDBOX_CLEANUP_RETRY_BATCH_SIZE);

    for (const { lease: row } of staleRows) {
      if (!readSandboxAcquisitionContext(toEnvironmentLeaseSnapshot(row))) continue;
      const transitionAt = new Date();
      await db
        .update(environmentLeases)
        .set({
          status: "pending_cleanup",
          releasedAt: transitionAt,
          lastUsedAt: transitionAt,
          failureReason: "provider_acquire_in_progress",
          cleanupStatus: "failed",
          cleanupClaimId: null,
          cleanupClaimedAt: null,
          metadata: sql<Record<string, unknown>>`
            coalesce(${environmentLeases.metadata}, '{}'::jsonb)
            || ${JSON.stringify({
              [PENDING_CLEANUP_RELEASE_STATUS_KEY]: "failed",
            })}::jsonb
          `,
        })
        .where(and(
          eq(environmentLeases.id, row.id),
          eq(environmentLeases.status, "active"),
          isNull(environmentLeases.providerLeaseId),
          eq(environmentLeases.updatedAt, row.updatedAt),
        ));
    }
  }

  function renewPendingSandboxCleanupClaim(leaseId: string, claimId: string) {
    const renewal = setInterval(() => {
      void db
        .update(environmentLeases)
        .set({ cleanupClaimedAt: new Date() })
        .where(
          and(
            eq(environmentLeases.id, leaseId),
            eq(environmentLeases.status, "pending_cleanup"),
            eq(environmentLeases.cleanupClaimId, claimId),
          ),
        )
        .catch((error) => {
          logger.warn({ err: error, leaseId }, "pending sandbox cleanup claim renewal failed");
        });
    }, SANDBOX_CLEANUP_CLAIM_RENEW_MS);
    renewal.unref();
    return renewal;
  }

  return {
    getDriver,

    async acquireRunLease(input: {
      companyId: string;
      environment: Environment;
      issueId: string | null;
      agentId?: string | null;
      /** Null for ad-hoc invocations (e.g. operator-initiated `Test` probes). */
      heartbeatRunId: string | null;
      persistedExecutionWorkspace: Pick<ExecutionWorkspace, "id" | "mode"> | null;
      /** The agent's adapter type for this run (mixed-harness environments). */
      adapterType?: string | null;
      /**
       * Force applying the active custom-image template even for ad-hoc (no
       * issue/run) invocations. Operator `Test` probes set this so the runtime
       * lease uses the operator-prepared custom image.
       */
      applyCustomImageTemplate?: boolean;
    }): Promise<EnvironmentRuntimeLeaseRecord> {
      if (input.environment.status !== "active") {
        throw new Error(`Environment "${input.environment.name}" is not active.`);
      }

      const leaseContext = buildEnvironmentLeaseContext({
        persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      });
      const driver = requireDriver(input.environment);
      const lease = await driver.acquireRunLease({
        companyId: input.companyId,
        environment: input.environment,
        issueId: input.issueId,
        agentId: input.agentId ?? null,
        heartbeatRunId: input.heartbeatRunId,
        executionWorkspaceId: leaseContext.executionWorkspaceId,
        executionWorkspaceMode: leaseContext.executionWorkspaceMode,
        adapterType: input.adapterType ?? null,
        applyCustomImageTemplate: input.applyCustomImageTemplate ?? false,
      });

      return {
        environment: input.environment,
        lease,
        leaseContext,
      };
    },

    async releaseRunLeases(
      heartbeatRunId: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> = "released",
    ): Promise<EnvironmentRuntimeLeaseRecord[]> {
      const pendingApprovedExecutions = await db
        .select({
          invocationId: toolInvocations.id,
          toolName: toolInvocations.toolName,
          signedArguments: toolActionRequests.signedArguments,
        })
        .from(toolActionRequests)
        .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
        .where(and(
          eq(toolInvocations.runId, heartbeatRunId),
          inArray(toolActionRequests.status, ["pending", "approved", "executing"]),
        ));
      const retainForApprovedExecution = pendingApprovedExecutions.some((row) => {
        try {
          return readSignedToolArgumentsPayload({
            signedArguments: row.signedArguments,
            invocationId: row.invocationId,
            toolName: row.toolName,
            signingSecret: options.toolActionSigningSecret,
          })?.executionOnApprove === true;
        } catch {
          return false;
        }
      });
      if (retainForApprovedExecution) return [];

      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.heartbeatRunId, heartbeatRunId),
            inArray(environmentLeases.status, ["active"]),
          ),
        );
      if (leaseRows.length === 0) {
        return [];
      }

      const released: EnvironmentRuntimeLeaseRecord[] = [];
      for (const leaseRow of leaseRows) {
        const targetStatus =
          leaseRow.leasePolicy === "reuse_by_environment" && status !== "released"
            ? ("expired" as const)
            : status;
        const environment = await environmentsSvc.getById(leaseRow.environmentId);
        const preclaimLease = toEnvironmentLeaseSnapshot(leaseRow);
        const driver = environment
          ? getDriver(getLeaseDriverKey(preclaimLease, environment))
          : null;
        if (!environment || !driver) {
          const deferredClaim = await claimSandboxCleanup({
            leaseId: leaseRow.id,
            expectedStatus: "active",
            targetStatus,
            requireAuthoritativeReusableLease: leaseRow.leasePolicy === "reuse_by_environment",
          });
          if (deferredClaim) {
            await deferSandboxCleanupClaim(
              deferredClaim,
              environment ? "environment_driver_unavailable" : "environment_unavailable",
            );
          } else if (leaseRow.leasePolicy === "reuse_by_environment") {
            await requestReusableSandboxCleanup(
              leaseRow.id,
              status === "released" ? "released" : "expired",
              status === "failed"
                ? "adapter_or_run_failure"
                : status === "expired"
                  ? "lease_expired"
                  : undefined,
            );
          }
          continue;
        }
        const requiresCleanupClaim =
          leaseRow.leasePolicy === "reuse_by_environment" ||
          (
            leaseRow.leasePolicy === "ephemeral" &&
            leaseRow.providerLeaseId !== null &&
            (driver.driver === "sandbox" || driver.driver === "plugin")
          );
        const claim = requiresCleanupClaim
          ? await claimSandboxCleanup({
              leaseId: leaseRow.id,
              expectedStatus: "active",
              targetStatus,
              requireAuthoritativeReusableLease: leaseRow.leasePolicy === "reuse_by_environment",
            })
          : null;
        if (requiresCleanupClaim && !claim) {
          if (leaseRow.leasePolicy === "reuse_by_environment") {
            await requestReusableSandboxCleanup(
              leaseRow.id,
              status === "released" ? "released" : "expired",
              status === "failed"
                ? "adapter_or_run_failure"
                : status === "expired"
                  ? "lease_expired"
                  : undefined,
            );
          }
          continue;
        }
        const claimedLeaseRow = claim?.row ?? leaseRow;

        const leaseSnapshot = toEnvironmentLeaseSnapshot(claimedLeaseRow);
        const claimRenewal = claim
          ? renewPendingSandboxCleanupClaim(leaseSnapshot.id, claim.claimId)
          : null;
        let lease: EnvironmentLease | null;
        try {
          lease = await driver.releaseRunLease({
            environment,
            lease: leaseSnapshot,
            status,
            cleanupClaimId: claim?.claimId,
          });
        } catch (error) {
          if (!claim) throw error;
          await deferSandboxCleanupClaim(
            claim,
            leaseSnapshot.failureReason ?? "cleanup_release_failed",
          );
          logger.warn(
            { err: error, leaseId: leaseSnapshot.id, environmentId: environment.id },
            "environment lease release failed",
          );
          continue;
        } finally {
          if (claimRenewal) clearInterval(claimRenewal);
        }
        if (!lease) continue;

        released.push({
          environment,
          lease,
          leaseContext: {
            executionWorkspaceId: lease.executionWorkspaceId,
            executionWorkspaceMode:
              (lease.metadata?.executionWorkspaceMode as ExecutionWorkspace["mode"] | null | undefined) ?? null,
          },
        });
      }

      return released;
    },

    async retryPendingSandboxCleanups() {
      const now = Date.now();
      const updatedBefore = new Date(now - SANDBOX_CLEANUP_RETRY_DELAY_MS);
      const claimStaleBefore = new Date(now - SANDBOX_CLEANUP_CLAIM_STALE_MS);
      await promoteStaleSandboxAcquisitionReservations(updatedBefore);
      const claimAvailable = or(
        isNull(environmentLeases.cleanupClaimedAt),
        lte(environmentLeases.cleanupClaimedAt, claimStaleBefore),
      );
      const leaseRows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.status, "pending_cleanup"),
            lte(environmentLeases.updatedAt, updatedBefore),
            claimAvailable,
            or(
              ne(environmentLeases.leasePolicy, "reuse_by_environment"),
              isAutomaticReusableEnvironmentLeaseCleanupCandidate(),
            ),
          ),
        )
        .orderBy(asc(environmentLeases.updatedAt))
        .limit(SANDBOX_CLEANUP_RETRY_BATCH_SIZE);

      let attempted = 0;
      let cleaned = 0;
      let terminalized = 0;
      for (const leaseRow of leaseRows) {
        const claim = await claimPendingSandboxCleanup({
          leaseId: leaseRow.id,
          updatedBefore,
          requireAuthoritativeReusableLease: leaseRow.leasePolicy === "reuse_by_environment",
        });
        if (!claim) continue;

        let lease = toEnvironmentLeaseSnapshot(claim.row);
        const environment = await environmentsSvc.getById(lease.environmentId);
        const driver = environment ? getDriver(getLeaseDriverKey(lease, environment)) : null;
        if (!environment || !driver) {
          await deferSandboxCleanupClaim(
            claim,
            lease.failureReason ?? "cleanup_prerequisite_unavailable",
          );
          continue;
        }

        attempted += 1;
        const claimRenewal = renewPendingSandboxCleanupClaim(lease.id, claim.claimId);
        try {
          let retried: EnvironmentLease | null | undefined;
          if (
            lease.metadata?.[SANDBOX_LEASE_RESERVATION_KEY] === true &&
            !lease.providerLeaseId
          ) {
            if (
              lease.metadata?.[SANDBOX_ACQUISITION_ID_KEY] !== lease.id ||
              !readSandboxAcquisitionContext(lease)
            ) {
              retried = await releaseEnvironmentLeaseAndDeleteBindings({
                db,
                lease,
                status: "failed",
                failureReason: "provider_acquire_replay_metadata_missing",
                cleanupClaimId: claim.claimId,
              });
            } else {
              if (!driver.recoverPendingAcquisition) {
                throw new Error(
                  `Environment driver "${driver.driver}" does not support pending acquisition recovery.`,
                );
              }
              lease = await driver.recoverPendingAcquisition({
                environment,
                lease,
                cleanupClaimId: claim.claimId,
              });
              retried = lease.status === "pending_cleanup" ? undefined : lease;
            }
          } else {
            retried = undefined;
          }
          if (retried === undefined) {
            const pendingTarget = String(lease.metadata?.[PENDING_CLEANUP_RELEASE_STATUS_KEY]);
            const retryReusableRelease =
              lease.leasePolicy === "reuse_by_environment" && pendingTarget === "released";
            if (lease.leasePolicy === "reuse_by_environment" && !retryReusableRelease && !driver.destroyRunLease) {
              throw new Error(`Environment driver "${driver.driver}" does not support lease destroy.`);
            }
            retried = lease.leasePolicy === "reuse_by_environment" && !retryReusableRelease
              ? await driver.destroyRunLease!({
                  environment,
                  lease,
                  cleanupClaimId: claim.claimId,
                  failureReason: lease.failureReason ?? "cleanup_retry",
                })
              : await driver.releaseRunLease({
                  environment,
                  lease,
                  cleanupClaimId: claim.claimId,
                  status: ["released", "expired", "failed"].includes(pendingTarget)
                    ? lease.metadata?.[PENDING_CLEANUP_RELEASE_STATUS_KEY] as "released" | "expired" | "failed"
                    : "expired",
                });
          }
          if (retried && retried.status !== "pending_cleanup") {
            const requiresManualCleanup =
              retried.failureReason === PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON;
            if (requiresManualCleanup) terminalized += 1;
            else cleaned += 1;
            if (requiresManualCleanup) continue;
            try {
              await logActivity(db, {
                companyId: retried.companyId,
                actorType: "system",
                actorId: "environment_cleanup_retry",
                runId: retried.heartbeatRunId,
                issueId: retried.issueId,
                action: "environment.lease_cleanup_completed",
                entityType: "environment_lease",
                entityId: retried.id,
                details: {
                  environmentId: retried.environmentId,
                  provider: retried.provider,
                  executionWorkspaceId: retried.executionWorkspaceId,
                  previousStatus: "pending_cleanup",
                  status: retried.status,
                  cleanupStatus: retried.cleanupStatus,
                },
              });
            } catch (error) {
              logger.warn({ err: error, leaseId: retried.id }, "failed to log completed sandbox cleanup retry");
            }
          }
        } catch (error) {
          await deferSandboxCleanupClaim(
            claim,
            lease.failureReason ?? "cleanup_retry_failed",
          );
          logger.warn(
            {
              err: error,
              leaseId: lease.id,
              environmentId: environment.id,
              provider: lease.provider,
            },
            "pending sandbox cleanup retry failed",
          );
        } finally {
          clearInterval(claimRenewal);
        }
      }

      await reconcileTerminalExecutionWorkspaces();

      return {
        attempted,
        cleaned,
        pending: attempted - cleaned - terminalized,
      };
    },

    destroyReusableSandboxLeases,

    async resumeRunLease(input: EnvironmentDriverLeaseInput): Promise<PluginEnvironmentLease | EnvironmentLease | null> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.resumeRunLease) {
        throw new Error(`Environment driver "${driver.driver}" does not support lease resume.`);
      }
      return await driver.resumeRunLease(input);
    },

    async destroyRunLease(input: EnvironmentDriverLeaseInput): Promise<EnvironmentLease | null> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.destroyRunLease) {
        throw new Error(`Environment driver "${driver.driver}" does not support lease destroy.`);
      }
      return await driver.destroyRunLease(input);
    },

    async realizeWorkspace(
      input: EnvironmentDriverRealizeWorkspaceInput,
    ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.realizeWorkspace) {
        throw new Error(`Environment driver "${driver.driver}" does not support workspace realization.`);
      }
      return await driver.realizeWorkspace(input);
    },

    async execute(input: EnvironmentDriverExecuteInput): Promise<PluginEnvironmentExecuteResult> {
      const driver = requireDriverKey(getLeaseDriverKey(input.lease, input.environment));
      if (!driver.execute) {
        throw new Error(`Environment driver "${driver.driver}" does not support command execution.`);
      }
      return await driver.execute(input);
    },
  };
}

export type EnvironmentRuntimeService = ReturnType<typeof environmentRuntimeService>;
