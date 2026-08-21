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

const SCHEMA_REF_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

  function findSchemaNode(
    node: unknown,
    predicate: (candidate: Record<string, unknown>) => boolean,
    seen: Set<unknown> = new Set(),
  ): Record<string, unknown> | null {
    if (Array.isArray(node)) {
      if (seen.has(node)) return null;
      seen.add(node);
      for (const child of node) {
        const found = findSchemaNode(child, predicate, seen);
        if (found) return found;
      }
      return null;
    }
    if (!isRecord(node) || seen.has(node)) return null;
    seen.add(node);
    if (predicate(node)) return node;
    for (const child of Object.values(node)) {
      const found = findSchemaNode(child, predicate, seen);
      if (found) return found;
    }
    return null;
  }

  function resolveLocalSchemaRef(ref: string): Record<string, unknown> | null {
    let decodedRef: string;
    try {
      decodedRef = decodeURIComponent(ref);
    } catch {
      return null;
    }
    if (decodedRef === "#") return schema ?? null;
    if (decodedRef.startsWith("#/")) {
      let current: unknown = schema;
      for (const encodedSegment of decodedRef.slice(2).split("/")) {
        if (!isRecord(current)) return null;
        const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
        if (
          SCHEMA_REF_PROTOTYPE_KEYS.has(segment)
          || !Object.prototype.hasOwnProperty.call(current, segment)
        ) {
          return null;
        }
        current = current[segment];
      }
      return isRecord(current) ? current : null;
    }
    if (!decodedRef.startsWith("#")) return null;
    const anchor = decodedRef.slice(1);
    return findSchemaNode(schema, (candidate) =>
      candidate.$anchor === anchor
      || candidate.$dynamicAnchor === anchor
      || candidate.$id === decodedRef);
  }

  function walk(
    node: Record<string, unknown>,
    prefix: string,
    value: unknown,
    seenRefs: ReadonlySet<string> = new Set(),
  ): void {
    if (node.format === "secret-ref" && prefix) {
      paths.add(prefix);
    }

    const ref = node.$ref;
    if (typeof ref === "string") {
      const refAtPath = `${ref}\u0000${prefix}`;
      if (!seenRefs.has(refAtPath)) {
        const resolved = resolveLocalSchemaRef(ref);
        if (resolved) {
          const nextSeenRefs = new Set(seenRefs);
          nextSeenRefs.add(refAtPath);
          walk(resolved, prefix, value, nextSeenRefs);
        }
      }
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!isRecord(branch)) continue;
        walk(branch, prefix, value, seenRefs);
      }
    }

    if (Array.isArray(value)) {
      const tupleItems = Array.isArray(node.items) ? node.items : [];
      const sharedItems = isRecord(node.items) ? node.items : null;
      const additionalItems = isRecord(node.additionalItems) ? node.additionalItems : null;
      value.forEach((item, index) => {
        const itemSchema = tupleItems[index] ?? sharedItems ?? (index >= tupleItems.length ? additionalItems : null);
        if (!isRecord(itemSchema)) return;
        walk(itemSchema, prefix ? `${prefix}.${index}` : String(index), item, seenRefs);
      });
    }

    const properties = node.properties;
    if (!isRecord(properties)) return;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!isRecord(propertySchema)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const propertyValue = readChild(value, key);
      walk(propertySchema, path, propertyValue, seenRefs);
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
