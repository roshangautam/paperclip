import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  pluginConfig,
} from "@paperclipai/db";
import {
  envBindingSecretRefSchema,
  type EnvSecretRefBinding,
  type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { validateInstanceConfig } from "./plugin-config-validator.js";
import {
  extractSecretRefBindingsFromConfig,
  MAX_PLUGIN_CONFIG_PATH_BYTES,
  type PluginConfigSecretRefBinding,
} from "./plugin-secrets-handler.js";

const MAX_CONFIG_PATH_SEGMENTS = 32;
const MAX_CONFIG_PATH_SEGMENT_BYTES = 256;
const MAX_PATCH_NODES = 1_024;
const MAX_PATCH_DEPTH = 32;
const MAX_PATCH_ARRAY_LENGTH = 256;
const CONFIG_PATH_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DELETE_VALUE = Symbol("delete-config-value");

type SecretPatchValue =
  | EnvSecretRefBinding
  | null
  | SecretPatchValue[]
  | { [key: string]: SecretPatchValue };

interface NormalizedPatch {
  value: SecretPatchValue;
  deletePaths: Set<string>;
  refCount: number;
}

interface PatchPluginConfigSecretRefsInput {
  companyId: unknown;
  path: unknown;
  value: unknown;
  schema?: PaperclipPluginManifestV1["instanceConfigSchema"];
}

interface CreatePluginConfigSecretRefPatcherOptions {
  db: Db;
  pluginId: string;
  pluginKey: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCompanyId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unprocessable("companyId is required for config.patchSecretRefs");
  }
  return value.trim();
}

function normalizePathSegment(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.includes(".")
    || CONFIG_PATH_CONTROL_CHARACTERS.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_CONFIG_PATH_SEGMENT_BYTES
    || PROTOTYPE_KEYS.has(value)
    || (ARRAY_INDEX.test(value) && Number(value) >= MAX_PATCH_ARRAY_LENGTH)
  ) {
    throw unprocessable("config.patchSecretRefs requires safe, non-empty path segments");
  }
  return value;
}

function normalizeConfigPath(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_CONFIG_PATH_SEGMENTS
  ) {
    throw unprocessable("config.patchSecretRefs requires a non-empty path");
  }
  const path = value.map(normalizePathSegment);
  if (Buffer.byteLength(path.join("."), "utf8") > MAX_PLUGIN_CONFIG_PATH_BYTES) {
    throw unprocessable("config.patchSecretRefs config path is too long");
  }
  return path;
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

function normalizeSecretPatch(value: unknown, basePath: string): NormalizedPatch {
  const deletePaths = new Set<string>();
  let refCount = 0;
  let nodeCount = 0;

  const visit = (current: unknown, path: string, depth: number): SecretPatchValue => {
    nodeCount += 1;
    if (nodeCount > MAX_PATCH_NODES || depth > MAX_PATCH_DEPTH) {
      throw unprocessable("config.patchSecretRefs patch is too large");
    }

    const parsedRef = envBindingSecretRefSchema.safeParse(current);
    if (parsedRef.success) {
      refCount += 1;
      return parsedRef.data;
    }
    if (current === null) {
      deletePaths.add(path);
      return null;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_PATCH_ARRAY_LENGTH) {
        throw unprocessable("config.patchSecretRefs arrays are too large");
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(current, index)) {
          throw unprocessable("config.patchSecretRefs arrays must not contain sparse entries");
        }
      }
      return current.map((item, index) => visit(item, `${path}.${index}`, depth + 1));
    }
    if (!isPlainRecord(current)) {
      throw unprocessable(
        "config.patchSecretRefs values may contain only secret_ref objects, nested containers, or null removals",
      );
    }
    if (current.type === "secret_ref") {
      throw unprocessable("config.patchSecretRefs received an invalid secret_ref object");
    }

    const result: Record<string, SecretPatchValue> = {};
    for (const [rawKey, child] of Object.entries(current)) {
      const key = normalizePathSegment(rawKey);
      const childPath = `${path}.${key}`;
      if (Buffer.byteLength(childPath, "utf8") > MAX_PLUGIN_CONFIG_PATH_BYTES) {
        throw unprocessable("config.patchSecretRefs config path is too long");
      }
      result[key] = visit(child, childPath, depth + 1);
    }
    return result;
  };

  const normalized = visit(value, basePath, 0);
  if (refCount === 0 && deletePaths.size === 0) {
    throw unprocessable("config.patchSecretRefs requires at least one secret_ref or null removal");
  }
  return { value: normalized, deletePaths, refCount };
}

function isSecretRef(value: SecretPatchValue | unknown): value is EnvSecretRefBinding {
  return envBindingSecretRefSchema.safeParse(value).success;
}

function mergeSecretPatch(
  current: unknown,
  patch: SecretPatchValue,
): unknown | typeof DELETE_VALUE {
  if (patch === null) return DELETE_VALUE;
  if (isSecretRef(patch)) {
    return { ...patch };
  }
  if (Array.isArray(patch)) {
    if (current !== undefined && !Array.isArray(current)) {
      throw unprocessable("config.patchSecretRefs cannot traverse an incompatible config value");
    }
    const result = Array.isArray(current) ? [...current] : [];
    patch.forEach((child, index) => {
      const merged = mergeSecretPatch(result[index], child);
      result[index] = merged === DELETE_VALUE ? null : merged;
    });
    return result;
  }

  if (current !== undefined && (!isPlainRecord(current) || isSecretRef(current))) {
    throw unprocessable("config.patchSecretRefs cannot traverse an incompatible config value");
  }
  const result = isPlainRecord(current) ? { ...current } : {};
  for (const [key, child] of Object.entries(patch)) {
    const merged = mergeSecretPatch(result[key], child);
    if (merged === DELETE_VALUE) delete result[key];
    else result[key] = merged;
  }
  return result;
}

function applyPatchAtPath(
  current: unknown,
  path: string[],
  patch: SecretPatchValue,
): unknown {
  if (path.length === 0) {
    const merged = mergeSecretPatch(current, patch);
    return merged === DELETE_VALUE ? undefined : merged;
  }

  const [segment, ...rest] = path;
  if (Array.isArray(current)) {
    if (!ARRAY_INDEX.test(segment)) {
      throw unprocessable("config.patchSecretRefs requires numeric path segments for arrays");
    }
    const index = Number(segment);
    if (index > current.length) {
      throw unprocessable("config.patchSecretRefs cannot create sparse arrays");
    }
    const result = [...current];
    result[index] = applyPatchAtPath(result[index], rest, patch);
    return result;
  }
  if (current !== undefined && (!isPlainRecord(current) || isSecretRef(current))) {
    throw unprocessable("config.patchSecretRefs cannot traverse an incompatible config value");
  }

  const result = isPlainRecord(current) ? { ...current } : {};
  const merged = applyPatchAtPath(result[segment], rest, patch);
  if (merged === undefined) delete result[segment];
  else result[segment] = merged;
  return result;
}

function clearConfigPath(current: unknown, path: string[]): unknown {
  if (path.length === 0) return current;
  const [segment, ...rest] = path;

  if (Array.isArray(current) && ARRAY_INDEX.test(segment)) {
    const index = Number(segment);
    if (index >= current.length) return current;
    const result = [...current];
    if (rest.length === 0) result[index] = null;
    else result[index] = clearConfigPath(result[index], rest);
    return result;
  }
  if (!isPlainRecord(current) || !(segment in current)) return current;

  const result = { ...current };
  if (rest.length === 0) delete result[segment];
  else result[segment] = clearConfigPath(result[segment], rest);
  return result;
}

function readConfigPath(
  current: unknown,
  path: string[],
): { found: boolean; value: unknown } {
  if (path.length === 0) return { found: true, value: current };
  const [segment, ...rest] = path;

  if (Array.isArray(current) && ARRAY_INDEX.test(segment)) {
    const index = Number(segment);
    if (index >= current.length) return { found: false, value: undefined };
    return readConfigPath(current[index], rest);
  }
  if (!isPlainRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
    return { found: false, value: undefined };
  }
  return readConfigPath(current[segment], rest);
}

function restoreConfigPath(
  current: unknown,
  original: unknown,
  path: string[],
): unknown {
  if (path.length === 0) return original;
  const [segment, ...rest] = path;

  if (Array.isArray(original) && ARRAY_INDEX.test(segment)) {
    const index = Number(segment);
    if (index >= original.length) return current;
    const result = Array.isArray(current) ? [...current] : [...original];
    result[index] = restoreConfigPath(result[index], original[index], rest);
    return result;
  }
  if (!isPlainRecord(original) || !Object.prototype.hasOwnProperty.call(original, segment)) {
    return current;
  }
  const result = isPlainRecord(current) ? { ...current } : { ...original };
  result[segment] = restoreConfigPath(result[segment], original[segment], rest);
  return result;
}

function configValueMatchesBinding(
  configJson: unknown,
  binding: { secretId: string; configPath: string; versionSelector: string },
): boolean {
  const current = readConfigPath(configJson, binding.configPath.split("."));
  if (!current.found) return false;
  const parsed = envBindingSecretRefSchema.safeParse(current.value);
  if (!parsed.success) return false;
  return parsed.data.secretId.toLowerCase() === binding.secretId.toLowerCase()
    && String(parsed.data.version ?? "latest") === binding.versionSelector;
}

function projectSecretRefsForSchema(value: unknown): unknown {
  const parsedRef = envBindingSecretRefSchema.safeParse(value);
  if (parsedRef.success) return parsedRef.data.secretId;
  if (Array.isArray(value)) return value.map(projectSecretRefsForSchema);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, projectSecretRefsForSchema(child)]),
  );
}

function schemaRecord(
  schema: PaperclipPluginManifestV1["instanceConfigSchema"] | undefined,
): Record<string, unknown> | null {
  return isPlainRecord(schema) ? schema : null;
}

async function validateBoundSecretVersions(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  companyId: string,
  refs: PluginConfigSecretRefBinding[],
): Promise<void> {
  const secretIds = [...new Set(refs.map((ref) => ref.secretId))];
  if (secretIds.length === 0) return;

  const secrets = await tx
    .select({
      id: companySecrets.id,
      latestVersion: companySecrets.latestVersion,
      scope: companySecrets.scope,
      status: companySecrets.status,
    })
    .from(companySecrets)
    .where(and(
      eq(companySecrets.companyId, companyId),
      inArray(companySecrets.id, secretIds),
    ));
  const secretsById = new Map(secrets.map((secret) => [secret.id, secret]));
  if (
    secretsById.size !== secretIds.length
    || secrets.some((secret) => secret.scope !== "company" || secret.status !== "active")
  ) {
    throw unprocessable("All plugin secret references must target active secrets in the same company");
  }

  const expectedVersions = new Map<string, { secretId: string; version: number }>();
  for (const ref of refs) {
    const secret = secretsById.get(ref.secretId);
    if (!secret) {
      throw unprocessable("All plugin secret references must target active secrets in the same company");
    }
    const version = ref.versionSelector === undefined || ref.versionSelector === "latest"
      ? secret.latestVersion
      : ref.versionSelector;
    if (
      !Number.isSafeInteger(version)
      || version <= 0
      || version > 2_147_483_647
    ) {
      throw unprocessable("Plugin secret references must use a valid secret version");
    }
    expectedVersions.set(`${ref.secretId}:${version}`, { secretId: ref.secretId, version });
  }

  const versionConditions = [...expectedVersions.values()].map(({ secretId, version }) =>
    and(
      eq(companySecretVersions.secretId, secretId),
      eq(companySecretVersions.version, version),
    ));
  const versions = await tx
    .select({
      secretId: companySecretVersions.secretId,
      version: companySecretVersions.version,
      status: companySecretVersions.status,
      revokedAt: companySecretVersions.revokedAt,
    })
    .from(companySecretVersions)
    .where(or(...versionConditions));
  const activeVersions = new Set(
    versions
      .filter((version) =>
        (version.status === "current" || version.status === "previous")
        && !version.revokedAt)
      .map((version) => `${version.secretId}:${version.version}`),
  );
  if ([...expectedVersions.keys()].some((key) => !activeVersions.has(key))) {
    throw unprocessable("All plugin secret references must target active secret versions");
  }
}

export function createPluginConfigSecretRefPatcher(
  options: CreatePluginConfigSecretRefPatcherOptions,
) {
  const { db, pluginId, pluginKey } = options;

  return async function patchPluginConfigSecretRefs(
    input: PatchPluginConfigSecretRefsInput,
  ): Promise<Record<string, unknown>> {
    const companyId = requireCompanyId(input.companyId);
    const path = normalizeConfigPath(input.path);
    const pathPrefix = path.join(".");
    const patch = normalizeSecretPatch(input.value, pathPrefix);
    const manifestSchema = schemaRecord(input.schema);

    return db.transaction(async (tx) => {
      await tx
        .insert(pluginConfig)
        .values({ pluginId, companyId, configJson: {} })
        .onConflictDoNothing();

      const configRow = await tx
        .select()
        .from(pluginConfig)
        .where(and(
          eq(pluginConfig.pluginId, pluginId),
          eq(pluginConfig.companyId, companyId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!configRow) throw new Error("Plugin config row was not available after initialization");

      const allBindings = await tx
        .select({
          id: companySecretBindings.id,
          secretId: companySecretBindings.secretId,
          configPath: companySecretBindings.configPath,
          versionSelector: companySecretBindings.versionSelector,
        })
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "plugin"),
          eq(companySecretBindings.targetId, pluginId),
        ));
      const subtreeBindings = allBindings.filter((binding) =>
        pathWithinPrefix(binding.configPath, pathPrefix));

      let nextConfig: Record<string, unknown>;
      if (input.value === null) {
        if (subtreeBindings.length === 0) {
          throw unprocessable("config.patchSecretRefs found no bound secret refs to remove");
        }
        let cleared: unknown = configRow.configJson;
        for (const binding of subtreeBindings) {
          if (configValueMatchesBinding(configRow.configJson, binding)) {
            cleared = clearConfigPath(cleared, binding.configPath.split("."));
          }
        }
        nextConfig = isPlainRecord(cleared) ? cleared : {};
      } else {
        for (const deletePath of patch.deletePaths) {
          const binding = allBindings.find((candidate) => candidate.configPath === deletePath);
          if (!binding) {
            throw unprocessable("config.patchSecretRefs may remove only currently bound secret refs");
          }
        }
        let patched = applyPatchAtPath(configRow.configJson, path, patch.value);
        for (const deletePath of patch.deletePaths) {
          const binding = allBindings.find((candidate) => candidate.configPath === deletePath)!;
          if (!configValueMatchesBinding(configRow.configJson, binding)) {
            patched = restoreConfigPath(
              patched,
              configRow.configJson,
              deletePath.split("."),
            );
          }
        }
        if (!isPlainRecord(patched)) {
          throw unprocessable("config.patchSecretRefs must preserve an object-shaped plugin config");
        }
        nextConfig = patched;
      }

      if (input.schema) {
        const validation = validateInstanceConfig(
          projectSecretRefsForSchema(nextConfig) as Record<string, unknown>,
          input.schema,
        );
        if (!validation.valid) {
          throw unprocessable("Plugin config validation failed", validation.errors);
        }
      }

      const nextRefs = extractSecretRefBindingsFromConfig(
        nextConfig,
        manifestSchema,
        { requireSchemaDeclaredRefs: true },
      ).filter((ref) => pathWithinPrefix(ref.configPath, pathPrefix));
      if (
        nextRefs.some((ref) =>
          Buffer.byteLength(ref.configPath, "utf8") > MAX_PLUGIN_CONFIG_PATH_BYTES)
      ) {
        throw unprocessable("config.patchSecretRefs config path is too long");
      }
      await validateBoundSecretVersions(tx, companyId, nextRefs);

      await tx
        .update(pluginConfig)
        .set({
          configJson: nextConfig,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(pluginConfig.id, configRow.id));

      if (subtreeBindings.length > 0) {
        await tx
          .delete(companySecretBindings)
          .where(inArray(
            companySecretBindings.id,
            subtreeBindings.map((binding) => binding.id),
          ));
      }
      if (nextRefs.length > 0) {
        await tx.insert(companySecretBindings).values(
          nextRefs.map((ref) => ({
            companyId,
            secretId: ref.secretId,
            targetType: "plugin",
            targetId: pluginId,
            configPath: ref.configPath,
            versionSelector: String(ref.versionSelector ?? "latest"),
            required: ref.required ?? true,
            label: ref.label ?? null,
            projectionClass: ref.projectionClass ?? "unclassified",
            projectionAllowlistKey: ref.projectionAllowlistKey ?? null,
          })),
        );
      }

      await tx.insert(activityLog).values({
        companyId,
        actorType: "plugin",
        actorId: pluginId,
        action: "plugin.config.secret_refs_patched",
        entityType: "plugin",
        entityId: pluginId,
        details: {
          configPath: pathPrefix,
          boundSecretCount: nextRefs.length,
          removedSecretCount: Math.max(0, subtreeBindings.length - nextRefs.length),
          sourcePluginId: pluginId,
          sourcePluginKey: pluginKey,
          pluginId,
          pluginKey,
        },
      });

      return nextConfig;
    });
  };
}
