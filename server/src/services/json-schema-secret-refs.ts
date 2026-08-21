const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

export type SecretRefBindingObject = {
  secretId: string;
  version: "latest" | number;
};

/**
 * Parses the `{ type: "secret_ref", secretId, version? }` binding object that
 * secret pickers submit for `format: "secret-ref"` config fields. Returns null
 * for anything else (raw values, bare secret-id strings, malformed objects).
 */
export function parseSecretRefBindingObject(value: unknown): SecretRefBindingObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "secret_ref") return null;
  if (typeof record.secretId !== "string" || !isUuidSecretRef(record.secretId.trim())) return null;
  const version = record.version;
  if (version === undefined || version === null || version === "latest") {
    return { secretId: record.secretId.trim(), version: "latest" };
  }
  if (typeof version === "number" && Number.isInteger(version) && version > 0) {
    return { secretId: record.secretId.trim(), version };
  }
  return null;
}

type ConfigContainer = Record<string, unknown> | unknown[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayIndex(key: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return null;
  const index = Number(key);
  return Number.isSafeInteger(index) ? index : null;
}

function readChild(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    const index = arrayIndex(key);
    return index === null ? undefined : value[index];
  }
  return isRecord(value) ? value[key] : undefined;
}

/**
 * Returns the concrete config paths for schema-declared secret references.
 *
 * JSON Schema has no numeric array indexes, but persisted configuration does.
 * When a schema marks an array item's field as `secret-ref`, `config` expands
 * that declaration into paths such as `agentCredentials.0.apiToken`. Callers
 * that read, write, bind, or resolve refs must supply the current config so
 * every present array item remains individually auditable.
 */
export function collectSecretRefPaths(
  schema: Record<string, unknown> | null | undefined,
  config?: Record<string, unknown>,
): Set<string> {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object") return paths;

  function walk(node: Record<string, unknown>, prefix: string, value: unknown): void {
    if (node.format === "secret-ref" && prefix) {
      paths.add(prefix);
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!isRecord(branch)) continue;
        walk(branch, prefix, value);
      }
    }

    const items = node.items;
    if (isRecord(items) && Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        walk(items, prefix ? `${prefix}.${index}` : String(index), value[index]);
      }
    }

    const properties = node.properties;
    if (!isRecord(properties)) return;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!isRecord(propertySchema)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const propertyValue = readChild(value, key);
      if (propertySchema.format === "secret-ref") {
        paths.add(path);
      }
      walk(propertySchema, path, propertyValue);
    }
  }

  walk(schema, "", config);
  return paths;
}

export function sortConfigPathsForRemoval(paths: Iterable<string>): string[] {
  // Removing an array item shifts each later index. Descending natural order
  // preserves the meaning of every concrete path collected from one config.
  return [...paths].sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
}

export function readConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
): unknown {
  let current: unknown = config;
  for (const key of dotPath.split(".")) {
    current = readChild(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

export function writeConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): Record<string, unknown> {
  const result = structuredClone(config) as Record<string, unknown>;
  const keys = dotPath.split(".");
  let cursor: ConfigContainer = result;

  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const nextKey = keys[index + 1]!;
    const next = readChild(cursor, key);
    const replacement: ConfigContainer = isRecord(next) || Array.isArray(next)
      ? next
      : arrayIndex(nextKey) === null ? {} : [];
    if (Array.isArray(cursor)) {
      const arrayPosition = arrayIndex(key);
      if (arrayPosition === null) return result;
      cursor[arrayPosition] = replacement;
    } else {
      cursor[key] = replacement;
    }
    cursor = replacement;
  }

  const leafKey = keys[keys.length - 1]!;
  if (Array.isArray(cursor)) {
    const arrayPosition = arrayIndex(leafKey);
    if (arrayPosition === null) return result;
    if (value === undefined) {
      cursor.splice(arrayPosition, 1);
    } else {
      cursor[arrayPosition] = value;
    }
  } else if (value === undefined) {
    delete cursor[leafKey];
  } else {
    cursor[leafKey] = value;
  }
  return result;
}
