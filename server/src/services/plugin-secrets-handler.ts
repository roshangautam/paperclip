/**
 * Plugin secrets host-side handler. Plugin workers may resolve shared
 * `secret_ref` config bindings only with an explicit company context.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySecretBindings,
  companySecrets,
  secretAccessEvents,
} from "@paperclipai/db";
import type { EnvSecretRefBinding, SecretProjectionClass, SecretVersionSelector } from "@paperclipai/shared";
import { envBindingSecretRefSchema } from "@paperclipai/shared";
import {
  collectSecretRefPaths,
  isUuidSecretRef,
  readConfigValueAtPath,
} from "./json-schema-secret-refs.js";
import { secretService } from "./secrets.js";
import { HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function invalidSecretRef(secretRef: unknown): Error {
  const rendered = typeof secretRef === "string" ? secretRef : JSON.stringify(secretRef);
  const err = new Error(
    `Invalid secret reference for plugin: ${rendered ?? "<empty>"}. Use { type: "secret_ref", secretId, version? }`,
  );
  err.name = "InvalidSecretRefError";
  return err;
}

function requireCompanyId(companyId: unknown): string {
  if (typeof companyId !== "string" || companyId.trim().length === 0) {
    throw unprocessable("companyId is required for plugin secret resolution");
  }
  return companyId.trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSecretRefBinding(value: unknown): EnvSecretRefBinding | null {
  const parsed = envBindingSecretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assertSecretRefBinding(
  value: unknown,
  path: string,
  rejectLegacyUuid = false,
): EnvSecretRefBinding | null {
  if (rejectLegacyUuid && typeof value === "string" && isUuidSecretRef(value)) {
    throw unprocessable(
      `Plugin secret ref at ${path} must use { type: "secret_ref", secretId, version? }`,
    );
  }
  if (!isPlainRecord(value) || value.type !== "secret_ref") return null;
  const parsed = parseSecretRefBinding(value);
  if (!parsed) {
    throw unprocessable(`Invalid secret_ref binding at ${path}`);
  }
  return parsed;
}

export interface PluginConfigSecretRefBinding {
  secretId: string;
  configPath: string;
  versionSelector?: SecretVersionSelector;
  required?: boolean;
  label?: string | null;
  projectionClass?: SecretProjectionClass;
  projectionAllowlistKey?: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Extract shared object-shaped secret refs from plugin config. */
export function extractSecretRefBindingsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): PluginConfigSecretRefBinding[] {
  if (configJson == null || typeof configJson !== "object") return [];

  const refsByPath = new Map<string, PluginConfigSecretRefBinding>();
  const addRef = (binding: EnvSecretRefBinding, configPath: string) => {
    refsByPath.set(configPath, {
      secretId: binding.secretId,
      configPath,
      versionSelector: binding.version ?? "latest",
      required: true,
      label: configPath,
      projectionClass: binding.projectionClass,
      projectionAllowlistKey: binding.projectionAllowlistKey ?? null,
    });
  };

  const secretPaths = collectSecretRefPaths(schema);
  for (const dotPath of secretPaths) {
    const current = readConfigValueAtPath(configJson as Record<string, unknown>, dotPath);
    const binding = assertSecretRefBinding(current, dotPath, true);
    if (binding) addRef(binding, dotPath);
  }

  function walk(value: unknown, path: string): void {
    const binding = assertSecretRefBinding(value, path || "$");
    if (binding) {
      addRef(binding, path || "$");
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path ? `${path}.${index}` : String(index)));
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  }

  walk(configJson, "");
  return [...refsByPath.values()];
}

/** Backward-compatible helper returning only secret IDs. */
export function extractSecretRefsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Set<string> {
  return new Set(extractSecretRefBindingsFromConfig(configJson, schema).map((ref) => ref.secretId));
}

/** Backward-compatible helper returning secret IDs grouped by config path. */
export function extractSecretRefPathsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  for (const ref of extractSecretRefBindingsFromConfig(configJson, schema)) {
    const paths = refs.get(ref.secretId) ?? new Set<string>();
    paths.add(ref.configPath);
    refs.set(ref.secretId, paths);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface PluginSecretsResolveParams {
  /** Shared secret reference object from company-scoped plugin config. */
  secretRef: string | EnvSecretRefBinding;
  /** Authorized company context for this worker invocation. */
  companyId?: string;
  /** Config path that produced this ref. Required when a secret appears in multiple paths. */
  configPath?: string;
}

export interface PluginSecretsHandlerOptions {
  db: Db;
  pluginId: string;
}

export interface PluginSecretsService {
  resolve(params: PluginSecretsResolveParams): Promise<string>;
}

function createRateLimiter(maxAttempts: number, windowMs: number) {
  const attempts = new Map<string, number[]>();
  let nextSweepAt = Date.now() + windowMs;

  function sweepStaleKeys(now: number): void {
    if (now < nextSweepAt) return;

    const windowStart = now - windowMs;
    for (const [key, timestamps] of attempts) {
      const active = timestamps.filter((timestamp) => timestamp > windowStart);
      if (active.length === 0) {
        attempts.delete(key);
      } else if (active.length !== timestamps.length) {
        attempts.set(key, active);
      }
    }
    nextSweepAt = now + windowMs;
  }

  return {
    check(key: string): boolean {
      const now = Date.now();
      sweepStaleKeys(now);
      const windowStart = now - windowMs;
      const existing = (attempts.get(key) ?? []).filter((ts) => ts > windowStart);
      if (existing.length >= maxAttempts) return false;
      existing.push(now);
      attempts.set(key, existing);
      return true;
    },
  };
}

function candidateSecretId(secretRef: unknown): string | null {
  if (typeof secretRef === "string") {
    const value = secretRef.trim();
    return isUuidSecretRef(value) ? value : null;
  }
  if (!isPlainRecord(secretRef) || typeof secretRef.secretId !== "string") return null;
  const value = secretRef.secretId.trim();
  return isUuidSecretRef(value) ? value : null;
}

function resolutionErrorCode(error: unknown): string {
  if (error instanceof HttpError && isPlainRecord(error.details)) {
    const code = error.details.code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  if (error instanceof Error) {
    if (error.name === "InvalidSecretRefError") return "invalid_secret_ref";
    if (error.name === "RateLimitExceededError") return "rate_limited";
  }
  return "plugin_secret_resolution_rejected";
}

export function createPluginSecretsHandler(
  options: PluginSecretsHandlerOptions,
): PluginSecretsService {
  const { db, pluginId } = options;
  const rateLimiter = createRateLimiter(30, 60_000);
  const rejectionAuditRateLimiter = createRateLimiter(30, 60_000);

  async function auditRejectedResolution(
    companyId: string,
    params: PluginSecretsResolveParams,
    errorCode: string,
  ): Promise<void> {
    const secretId = candidateSecretId(params.secretRef);
    const [secret] = secretId
      ? await db
        .select({
          id: companySecrets.id,
          latestVersion: companySecrets.latestVersion,
          provider: companySecrets.provider,
          scope: companySecrets.scope,
        })
        .from(companySecrets)
        .where(and(
          eq(companySecrets.id, secretId),
          eq(companySecrets.companyId, companyId),
        ))
        .limit(1)
      : [];
    const parsedRef = parseSecretRefBinding(params.secretRef);
    const version = parsedRef
      ? typeof parsedRef.version === "number"
        ? Number.isSafeInteger(parsedRef.version) &&
          parsedRef.version > 0 &&
          parsedRef.version <= 2_147_483_647
          ? parsedRef.version
          : null
        : secret?.latestVersion ?? null
      : null;
    const requestedConfigPath = typeof params.configPath === "string"
      ? params.configPath.trim()
      : "";
    const [binding] = secret?.id && requestedConfigPath
      ? await db
        .select({ configPath: companySecretBindings.configPath })
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "plugin"),
          eq(companySecretBindings.targetId, pluginId),
          eq(companySecretBindings.secretId, secret.id),
          eq(companySecretBindings.configPath, requestedConfigPath),
        ))
        .limit(1)
      : [];

    await db.insert(secretAccessEvents).values({
      companyId,
      secretId: secret?.id ?? null,
      secretScope: secret?.scope ?? "company",
      version,
      provider: secret?.provider ?? "unknown",
      actorType: "plugin",
      actorId: pluginId,
      consumerType: "plugin_worker",
      consumerId: pluginId,
      configPath: binding?.configPath ?? null,
      issueId: null,
      heartbeatRunId: null,
      pluginId,
      outcome: "failure",
      errorCode,
    });
  }

  async function bestEffortAuditRejectedResolution(
    companyId: string,
    params: PluginSecretsResolveParams,
    errorCode: string,
  ): Promise<void> {
    if (!rejectionAuditRateLimiter.check(`${companyId}:${pluginId}`)) return;
    try {
      await auditRejectedResolution(companyId, params, errorCode);
    } catch (auditError) {
      logger.warn(
        { err: auditError, companyId, pluginId, errorCode },
        "failed to record rejected plugin secret resolution",
      );
    }
  }

  async function lookupBinding(input: {
    companyId: string;
    secretId: string;
    versionSelector: SecretVersionSelector;
    configPath?: string;
  }) {
    const conditions = [
      eq(companySecretBindings.companyId, input.companyId),
      eq(companySecretBindings.targetType, "plugin"),
      eq(companySecretBindings.targetId, pluginId),
      eq(companySecretBindings.secretId, input.secretId),
    ];
    if (input.configPath) {
      conditions.push(eq(companySecretBindings.configPath, input.configPath));
    }
    const rows = await db
      .select()
      .from(companySecretBindings)
      .where(and(...conditions));
    const matchingVersion = rows.filter(
      (row) => row.versionSelector === String(input.versionSelector),
    );
    return matchingVersion;
  }

  return {
    async resolve(params: PluginSecretsResolveParams): Promise<string> {
      const companyId = requireCompanyId(params.companyId);
      const configPath = typeof params.configPath === "string"
        ? params.configPath.trim() || undefined
        : undefined;
      const normalizedParams = { ...params, configPath };
      const prepared = await (async () => {
        if (typeof params.secretRef === "string") {
          throw invalidSecretRef(params.secretRef.trim() || "<empty>");
        }

        const bindingRef = parseSecretRefBinding(params.secretRef);
        if (!bindingRef) throw invalidSecretRef(params.secretRef);

        if (!rateLimiter.check(`${companyId}:${pluginId}`)) {
          const err = new Error("Rate limit exceeded for secret resolution");
          err.name = "RateLimitExceededError";
          throw err;
        }

        const versionSelector = bindingRef.version ?? "latest";
        const bindings = await lookupBinding({
          companyId,
          secretId: bindingRef.secretId,
          versionSelector,
          configPath,
        });

        if (bindings.length === 0) {
          throw unprocessable(
            `Secret is not bound to plugin:${pluginId}${configPath ? ` at ${configPath}` : ""}`,
            { code: "binding_missing" },
          );
        }
        if (bindings.length > 1) {
          throw unprocessable(
            "Plugin secret reference is ambiguous; pass configPath when resolving this secret",
            { code: "binding_ambiguous" },
          );
        }

        return { bindingRef, versionSelector, binding: bindings[0]! };
      })().catch(async (error: unknown) => {
        await bestEffortAuditRejectedResolution(
          companyId,
          normalizedParams,
          resolutionErrorCode(error),
        );
        throw error;
      });

      const { bindingRef, versionSelector, binding } = prepared;
      return secretService(db).resolveSecretValue(companyId, bindingRef.secretId, versionSelector, {
        bindingContext: {
          consumerType: "plugin",
          consumerId: pluginId,
          configPath: binding.configPath,
          actorType: "plugin",
          actorId: pluginId,
          issueId: null,
          heartbeatRunId: null,
          pluginId,
        },
        accessContext: {
          consumerType: "plugin_worker",
          consumerId: pluginId,
          configPath: binding.configPath,
          actorType: "plugin",
          actorId: pluginId,
          issueId: null,
          heartbeatRunId: null,
          pluginId,
        },
      });
    },
  };
}
