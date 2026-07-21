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
import { isUuidSecretRef } from "./json-schema-secret-refs.js";
import { secretService } from "./secrets.js";
import { HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------
export const MAX_PLUGIN_CONFIG_PATH_BYTES = 2_048;

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

const SCHEMA_ARRAY_APPLICATORS = ["allOf", "anyOf", "oneOf"] as const;
const SCHEMA_SINGLE_APPLICATORS = ["not", "if", "then", "else"] as const;
const SCHEMA_MAP_APPLICATORS = [
  "properties",
  "patternProperties",
] as const;
const SCHEMA_VALUE_APPLICATORS = [
  "additionalProperties",
  "additionalItems",
] as const;
const UNSUPPORTED_AJV_SCHEMA_KEYWORDS = [
  "$dynamicRef",
  "dependentSchemas",
  "prefixItems",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const AMBIGUOUS_SECRET_SCHEMA_KEYWORDS = [
  "contains",
  "if",
  "then",
  "else",
  "not",
] as const;
const NON_APPLICATOR_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$ref",
  "$dynamicRef",
  "$defs",
  "definitions",
  "$comment",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "format",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "propertyNames",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  ...SCHEMA_ARRAY_APPLICATORS,
  ...SCHEMA_SINGLE_APPLICATORS,
  ...SCHEMA_MAP_APPLICATORS,
  ...SCHEMA_VALUE_APPLICATORS,
  "dependencies",
  "contains",
  "items",
]);
const SCHEMA_REF_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function containsSecretRefFormat(
  value: unknown,
  rootSchema: unknown,
  seenNodes: Set<unknown> = new Set(),
  seenRefs: ReadonlySet<string> = new Set(),
): boolean {
  if (isPlainRecord(value)) {
    if (seenNodes.has(value)) return false;
    seenNodes.add(value);
    if (value.format === "secret-ref" || typeof value.$dynamicRef === "string") return true;

    if (typeof value.$ref === "string" && !seenRefs.has(value.$ref)) {
      const resolved = resolveLocalSchemaRef(rootSchema, value.$ref);
      if (!resolved) return true;
      const nextSeenRefs = new Set(seenRefs);
      nextSeenRefs.add(value.$ref);
      if (containsSecretRefFormat(resolved, rootSchema, seenNodes, nextSeenRefs)) return true;
    }

    return Object.values(value).some((child) =>
      containsSecretRefFormat(child, rootSchema, seenNodes, seenRefs));
  }
  if (Array.isArray(value)) {
    if (seenNodes.has(value)) return false;
    seenNodes.add(value);
    return value.some((child) =>
      containsSecretRefFormat(child, rootSchema, seenNodes, seenRefs));
  }
  return false;
}

function assertNoUnsupportedSecretRefConstructs(
  schema: Record<string, unknown>,
  rootSchema: unknown,
): void {
  if (
    schema !== rootSchema
    && typeof schema.$id === "string"
    && !schema.$id.startsWith("#")
  ) {
    throw unprocessable(
      "Plugin config schema nested $id resource scopes are not supported",
    );
  }
  for (const keyword of UNSUPPORTED_AJV_SCHEMA_KEYWORDS) {
    if (schema[keyword] !== undefined) {
      throw unprocessable(
        `Plugin config schema keyword "${keyword}" is not supported by the config validator`,
      );
    }
  }
  for (const keyword of AMBIGUOUS_SECRET_SCHEMA_KEYWORDS) {
    if (containsSecretRefFormat(schema[keyword], rootSchema)) {
      throw unprocessable(
        `Plugin config schema cannot declare secret refs through conditional keyword "${keyword}"`,
      );
    }
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && containsSecretRefFormat(branches, rootSchema)) {
      const secretBranches = branches.filter((branch) =>
        containsSecretRefFormat(branch, rootSchema));
      const onlyOneSecretWithEmptyAlternatives = secretBranches.length === 1
        && branches.every((branch) => {
        if (containsSecretRefFormat(branch, rootSchema)) return branch === secretBranches[0];
        if (!isPlainRecord(branch)) return false;
        if (branch.type === "null" || branch.const === null || branch.const === "") return true;
        return Array.isArray(branch.enum)
          && branch.enum.every((value) => value === null || value === "");
      });
      if (!onlyOneSecretWithEmptyAlternatives) {
        throw unprocessable(
          `Plugin config schema cannot ambiguously declare secret refs through "${keyword}"`,
        );
      }
    }
  }

  for (const [keyword, value] of Object.entries(schema)) {
    if (
      SUPPORTED_SCHEMA_KEYWORDS.has(keyword)
      || NON_APPLICATOR_SCHEMA_KEYWORDS.has(keyword)
    ) {
      continue;
    }
    if (containsSecretRefFormat(value, rootSchema)) {
      throw unprocessable(
        `Plugin config schema uses unsupported secret-ref keyword "${keyword}"`,
      );
    }
  }
}

function findSchemaNode(
  rootSchema: unknown,
  predicate: (schema: Record<string, unknown>) => boolean,
  seen: Set<unknown> = new Set(),
): unknown | null {
  if (isPlainRecord(rootSchema)) {
    if (seen.has(rootSchema)) return null;
    seen.add(rootSchema);
    if (predicate(rootSchema)) return rootSchema;
    const children: unknown[] = [];
    for (const keyword of SCHEMA_ARRAY_APPLICATORS) {
      const schemas = rootSchema[keyword];
      if (Array.isArray(schemas)) children.push(...schemas);
    }
    for (const keyword of SCHEMA_SINGLE_APPLICATORS) {
      if (rootSchema[keyword] !== undefined) children.push(rootSchema[keyword]);
    }
    for (const keyword of SCHEMA_MAP_APPLICATORS) {
      const schemas = rootSchema[keyword];
      if (isPlainRecord(schemas)) children.push(...Object.values(schemas));
    }
    for (const keyword of ["$defs", "definitions"] as const) {
      const definitions = rootSchema[keyword];
      if (isPlainRecord(definitions)) children.push(...Object.values(definitions));
    }
    if (isPlainRecord(rootSchema.dependencies)) {
      children.push(
        ...Object.values(rootSchema.dependencies).filter((dependency) =>
          !Array.isArray(dependency)),
      );
    }
    if (Array.isArray(rootSchema.items)) children.push(...rootSchema.items);
    else if (rootSchema.items !== undefined) children.push(rootSchema.items);
    for (const keyword of [...SCHEMA_VALUE_APPLICATORS, "contains"] as const) {
      if (rootSchema[keyword] !== undefined) children.push(rootSchema[keyword]);
    }
    for (const child of children) {
      const found = findSchemaNode(child, predicate, seen);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(rootSchema)) {
    if (seen.has(rootSchema)) return null;
    seen.add(rootSchema);
    for (const child of rootSchema) {
      const found = findSchemaNode(child, predicate, seen);
      if (found) return found;
    }
  }
  return null;
}

function resolveLocalSchemaRef(rootSchema: unknown, ref: string): unknown | null {
  let decodedRef: string;
  try {
    decodedRef = decodeURIComponent(ref);
  } catch {
    return null;
  }

  if (decodedRef === "#") return rootSchema;
  if (decodedRef.startsWith("#/")) {
    let current = rootSchema;
    for (const encodedSegment of decodedRef.slice(2).split("/")) {
      if (!isPlainRecord(current)) return null;
      const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (
        SCHEMA_REF_PROTOTYPE_KEYS.has(segment)
        || !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return null;
      }
      current = current[segment];
      if (
        isPlainRecord(current)
        && current !== rootSchema
        && typeof current.$id === "string"
        && !current.$id.startsWith("#")
      ) {
        return null;
      }
    }
    return current ?? null;
  }

  if (decodedRef.startsWith("#")) {
    const anchor = decodedRef.slice(1);
    return findSchemaNode(rootSchema, (schema) =>
      schema.$anchor === anchor
      || schema.$dynamicAnchor === anchor
      || schema.$id === decodedRef);
  }

  return null;
}

function schemaDeclaresSecretRefs(
  schema: unknown,
  rootSchema: unknown = schema,
  seenRefs: ReadonlySet<string> = new Set(),
): boolean {
  if (!isPlainRecord(schema)) return false;
  assertNoUnsupportedSecretRefConstructs(schema, rootSchema);
  if (schema.format === "secret-ref") return true;

  for (const refKeyword of ["$ref"] as const) {
    const ref = schema[refKeyword];
    if (typeof ref !== "string") continue;
    if (seenRefs.has(ref)) continue;
    const resolved = resolveLocalSchemaRef(rootSchema, ref);
    if (!resolved) return true;
    const nextSeenRefs = new Set(seenRefs);
    nextSeenRefs.add(ref);
    if (schemaDeclaresSecretRefs(resolved, rootSchema, nextSeenRefs)) return true;
  }

  for (const keyword of SCHEMA_ARRAY_APPLICATORS) {
    const branches = schema[keyword];
    if (
      Array.isArray(branches)
      && branches.some((branch) => schemaDeclaresSecretRefs(branch, rootSchema, seenRefs))
    ) {
      return true;
    }
  }

  for (const keyword of SCHEMA_SINGLE_APPLICATORS) {
    if (schemaDeclaresSecretRefs(schema[keyword], rootSchema, seenRefs)) return true;
  }

  for (const keyword of SCHEMA_MAP_APPLICATORS) {
    const schemas = schema[keyword];
    if (
      isPlainRecord(schemas)
      && Object.values(schemas).some((child) =>
        schemaDeclaresSecretRefs(child, rootSchema, seenRefs))
    ) {
      return true;
    }
  }

  if (isPlainRecord(schema.dependencies)) {
    for (const dependency of Object.values(schema.dependencies)) {
      if (
        !Array.isArray(dependency)
        && schemaDeclaresSecretRefs(dependency, rootSchema, seenRefs)
      ) {
        return true;
      }
    }
  }

  const itemSchemas = Array.isArray(schema.items) ? schema.items : [schema.items];
  if (itemSchemas.some((item) => schemaDeclaresSecretRefs(item, rootSchema, seenRefs))) return true;

  return SCHEMA_VALUE_APPLICATORS.some((keyword) =>
    schemaDeclaresSecretRefs(schema[keyword], rootSchema, seenRefs));
}

function visitSchemaSecretValues(
  value: unknown,
  schema: unknown,
  path: string,
  visit: (value: unknown, path: string) => void,
  rootSchema: unknown = schema,
  seenRefs: ReadonlySet<string> = new Set(),
): void {
  if (!isPlainRecord(schema)) return;
  assertNoUnsupportedSecretRefConstructs(schema, rootSchema);

  for (const refKeyword of ["$ref"] as const) {
    const ref = schema[refKeyword];
    if (typeof ref !== "string") continue;
    const refAtPath = `${ref}\u0000${path}`;
    if (seenRefs.has(refAtPath)) continue;
    const resolved = resolveLocalSchemaRef(rootSchema, ref);
    if (!resolved) {
      throw unprocessable(`Unsupported plugin config schema reference "${ref}"`);
    }
    const nextSeenRefs = new Set(seenRefs);
    nextSeenRefs.add(refAtPath);
    visitSchemaSecretValues(value, resolved, path, visit, rootSchema, nextSeenRefs);
  }

  for (const keyword of SCHEMA_ARRAY_APPLICATORS) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      visitSchemaSecretValues(value, branch, path, visit, rootSchema, seenRefs);
    }
  }
  for (const keyword of SCHEMA_SINGLE_APPLICATORS) {
    const childSchema = schema[keyword];
    if (childSchema !== undefined) {
      visitSchemaSecretValues(value, childSchema, path, visit, rootSchema, seenRefs);
    }
  }

  if (schema.format === "secret-ref") {
    visit(value, path || "$");
    return;
  }

  if (Array.isArray(value)) {
    const tupleItems = Array.isArray(schema.items) ? schema.items : [];
    const sharedItems = isPlainRecord(schema.items) ? schema.items : null;
    const visitedIndexes = new Set<number>();
    value.forEach((item, index) => {
      const itemSchema = tupleItems[index] ?? sharedItems;
      if (itemSchema) {
        visitedIndexes.add(index);
        visitSchemaSecretValues(
          item,
          itemSchema,
          path ? `${path}.${index}` : String(index),
          visit,
          rootSchema,
          seenRefs,
        );
      }
    });
    const remainingItemsSchema = schema.additionalItems;
    if (remainingItemsSchema !== undefined) {
      value.forEach((item, index) => {
        if (visitedIndexes.has(index)) return;
        visitSchemaSecretValues(
          item,
          remainingItemsSchema,
          path ? `${path}.${index}` : String(index),
          visit,
          rootSchema,
          seenRefs,
        );
      });
    }
    return;
  }

  if (!isPlainRecord(value)) return;
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  const visitedKeys = new Set<string>();
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    visitedKeys.add(key);
    visitSchemaSecretValues(
      value[key],
      propertySchema,
      path ? `${path}.${key}` : key,
      visit,
      rootSchema,
      seenRefs,
    );
  }

  const patternProperties = isPlainRecord(schema.patternProperties)
    ? schema.patternProperties
    : {};
  for (const [pattern, propertySchema] of Object.entries(patternProperties)) {
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern);
    } catch {
      throw unprocessable(`Invalid patternProperties expression "${pattern}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!matcher.test(key)) continue;
      visitedKeys.add(key);
      visitSchemaSecretValues(
        child,
        propertySchema,
        path ? `${path}.${key}` : key,
        visit,
        rootSchema,
        seenRefs,
      );
    }
  }

  for (const keyword of ["additionalProperties"] as const) {
    const additionalSchema = schema[keyword];
    if (!isPlainRecord(additionalSchema)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (visitedKeys.has(key)) continue;
      visitSchemaSecretValues(
        child,
        additionalSchema,
        path ? `${path}.${key}` : key,
        visit,
        rootSchema,
        seenRefs,
      );
    }
  }

  for (const keyword of ["dependencies"] as const) {
    const dependentSchemas = isPlainRecord(schema[keyword]) ? schema[keyword] : {};
    for (const [key, dependentSchema] of Object.entries(dependentSchemas)) {
      if (
        !Object.prototype.hasOwnProperty.call(value, key)
        || Array.isArray(dependentSchema)
      ) {
        continue;
      }
      visitSchemaSecretValues(
        value,
        dependentSchema,
        path,
        visit,
        rootSchema,
        seenRefs,
      );
    }
  }
}

function parseSecretRefBinding(value: unknown): EnvSecretRefBinding | null {
  const parsed = envBindingSecretRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assertSecretRefBinding(
  value: unknown,
  path: string,
  options: {
    rejectLegacyUuid?: boolean;
    rejectRawSecretValue?: boolean;
  } = {},
): EnvSecretRefBinding | null {
  const isEmptyValue = value === undefined
    || value === null
    || (typeof value === "string" && value.trim().length === 0);
  if (isEmptyValue) return null;

  if (
    options.rejectLegacyUuid
    && typeof value === "string"
    && isUuidSecretRef(value.trim())
  ) {
    throw unprocessable(
      `Plugin secret ref at ${path} must use { type: "secret_ref", secretId, version? }`,
    );
  }
  if (!isPlainRecord(value) || value.type !== "secret_ref") {
    if (options.rejectRawSecretValue) {
      throw unprocessable(
        `Plugin secret value at ${path} must use { type: "secret_ref", secretId, version? }`,
      );
    }
    return null;
  }
  const parsed = parseSecretRefBinding(value);
  if (!parsed) throw unprocessable(`Invalid secret_ref binding at ${path}`);
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

export interface ExtractSecretRefBindingsOptions {
  requireSchemaDeclaredRefs?: boolean;
}

/** Extract object-shaped secret refs while rejecting legacy UUID values. */
export function extractSecretRefBindingsFromConfig(
  configJson: unknown,
  schema?: Record<string, unknown> | null,
  options: ExtractSecretRefBindingsOptions = {},
): PluginConfigSecretRefBinding[] {
  if (!isPlainRecord(configJson)) return [];

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

  schemaDeclaresSecretRefs(schema);
  const requireDeclaredRefPaths = Boolean(
    options.requireSchemaDeclaredRefs
    && isPlainRecord(schema)
    && Object.keys(schema).length > 0,
  );
  const schemaDeclaredRefPaths = new Set<string>();
  visitSchemaSecretValues(configJson, schema, "", (current, configPath) => {
    const binding = assertSecretRefBinding(current, configPath, {
      rejectLegacyUuid: true,
      rejectRawSecretValue: true,
    });
    if (binding) {
      schemaDeclaredRefPaths.add(configPath);
      addRef(binding, configPath);
    }
  });

  function walk(value: unknown, path: string): void {
    const binding = assertSecretRefBinding(value, path || "$");
    if (binding) {
      const configPath = path || "$";
      if (
        requireDeclaredRefPaths
        && !schemaDeclaredRefPaths.has(configPath)
      ) {
        throw unprocessable(
          `Plugin secret ref at ${configPath} must be declared with format "secret-ref" in the plugin config schema`,
        );
      }
      addRef(binding, configPath);
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
