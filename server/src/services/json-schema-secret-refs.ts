const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

const SCHEMA_REF_PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Security: config paths are dot-joined strings shared by builders, readers,
// writers, and persisted secret-ref bindings. A literal key may contain a dot
// (e.g. `tokens."github.com"`), so segments are escaped JSON-Pointer style
// (`~` -> `~0`, `.` -> `~1`) to keep the join reversible; otherwise such a key
// is unreachable and its plaintext is neither converted nor redacted.
function encodePathSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll(".", "~1");
}

function decodePathSegment(segment: string): string {
  return segment.replaceAll("~1", ".").replaceAll("~0", "~");
}

function joinConfigPath(prefix: string, segment: string | number): string {
  const encoded = typeof segment === "number" ? String(segment) : encodePathSegment(segment);
  return prefix ? `${prefix}.${encoded}` : encoded;
}

function splitConfigPath(dotPath: string): string[] {
  return dotPath.split(".").map(decodePathSegment);
}

export function encodeConfigPathSegment(segment: string | number): string {
  return typeof segment === "number" ? String(segment) : encodePathSegment(segment);
}

function resolveLocalSchemaRef(
  rootSchema: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | null {
  let decodedRef: string;
  try {
    decodedRef = decodeURIComponent(ref);
  } catch {
    return null;
  }

  if (decodedRef === "#") return rootSchema;
  if (!decodedRef.startsWith("#/")) return null;

  let current: unknown = rootSchema;
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
  }
  return isPlainRecord(current) ? current : null;
}

export function inspectSecretRefPaths(
  schema: Record<string, unknown> | null | undefined,
  config?: Record<string, unknown>,
): { paths: Set<string>; inspectable: boolean } {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object") return { paths, inspectable: false };
  const rootSchema = schema;

  const hasConfig = config !== undefined;
  let complete = true;
  let sawInspectableStructure = false;

  function walk(
    node: Record<string, unknown>,
    prefix: string,
    value: unknown,
    seenRefs: ReadonlySet<string>,
  ): void {
    const ref = node.$ref;
    if (ref !== undefined) {
      if (typeof ref !== "string") {
        complete = false;
      } else {
        const refAtPath = hasConfig ? `${ref}\u0000${prefix}` : ref;
        if (!seenRefs.has(refAtPath)) {
          const resolved = resolveLocalSchemaRef(rootSchema, ref);
          if (!resolved) {
            complete = false;
          } else {
            const nextSeenRefs = new Set(seenRefs);
            nextSeenRefs.add(refAtPath);
            walk(resolved, prefix, value, nextSeenRefs);
          }
        }
      }
    }

    if (prefix && node.format === "secret-ref") {
      sawInspectableStructure = true;
      paths.add(prefix);
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (branches === undefined) continue;
      if (!Array.isArray(branches)) {
        complete = false;
        continue;
      }
      if (branches.length > 0) sawInspectableStructure = true;
      for (const branch of branches) {
        if (branch === false) continue;
        if (!isPlainRecord(branch)) {
          complete = false;
          continue;
        }
        walk(branch, prefix, value, seenRefs);
      }
    }

    const properties = node.properties;
    const visitedKeys = new Set<string>();
    if (properties !== undefined && !isPlainRecord(properties)) {
      complete = false;
    } else if (isPlainRecord(properties)) {
      if (Object.keys(properties).length > 0) sawInspectableStructure = true;
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (propertySchema === false) continue;
        if (!isPlainRecord(propertySchema)) {
          complete = false;
          continue;
        }
        if (
          hasConfig
          && (!isPlainRecord(value) || !Object.prototype.hasOwnProperty.call(value, key))
        ) {
          continue;
        }
        visitedKeys.add(key);
        const path = joinConfigPath(prefix, key);
        const propertyValue = isPlainRecord(value)
          ? value[key]
          : undefined;
        walk(propertySchema, path, propertyValue, seenRefs);
      }
    }

    const patternProperties = node.patternProperties;
    if (patternProperties !== undefined && !isPlainRecord(patternProperties)) {
      complete = false;
    } else if (isPlainRecord(patternProperties)) {
      if (Object.keys(patternProperties).length > 0) sawInspectableStructure = true;
      for (const [pattern, propertySchema] of Object.entries(patternProperties)) {
        if (propertySchema === false) continue;
        if (!isPlainRecord(propertySchema)) {
          complete = false;
          continue;
        }
        let matcher: RegExp;
        try {
          matcher = new RegExp(pattern);
        } catch {
          complete = false;
          continue;
        }
        if (!isPlainRecord(value)) continue;
        for (const [key, propertyValue] of Object.entries(value)) {
          if (!matcher.test(key)) continue;
          visitedKeys.add(key);
          const path = joinConfigPath(prefix, key);
          walk(propertySchema, path, propertyValue, seenRefs);
        }
      }
    }

    const additionalProperties = node.additionalProperties;
    if (isPlainRecord(additionalProperties)) {
      sawInspectableStructure = true;
      if (isPlainRecord(value)) {
        for (const [key, propertyValue] of Object.entries(value)) {
          if (visitedKeys.has(key)) continue;
          const path = joinConfigPath(prefix, key);
          walk(additionalProperties, path, propertyValue, seenRefs);
        }
      }
    } else if (
      additionalProperties !== undefined
      && typeof additionalProperties !== "boolean"
    ) {
      complete = false;
    }

    const items = node.items;
    if (Array.isArray(items)) {
      if (items.length > 0) sawInspectableStructure = true;
      const visitedIndexes = new Set<number>();
      items.forEach((itemSchema, index) => {
        if (itemSchema === false) return;
        if (!isPlainRecord(itemSchema)) {
          complete = false;
          return;
        }
        if (!Array.isArray(value) || index >= value.length) return;
        visitedIndexes.add(index);
        const path = joinConfigPath(prefix, index);
        walk(itemSchema, path, value[index], seenRefs);
      });
      const additionalItems = node.additionalItems;
      if (isPlainRecord(additionalItems)) {
        sawInspectableStructure = true;
        if (Array.isArray(value)) {
          value.forEach((entry, index) => {
            if (visitedIndexes.has(index)) return;
            const path = joinConfigPath(prefix, index);
            walk(additionalItems, path, entry, seenRefs);
          });
        }
      } else if (additionalItems !== undefined && typeof additionalItems !== "boolean") {
        complete = false;
      }
    } else if (isPlainRecord(items)) {
      sawInspectableStructure = true;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          const path = joinConfigPath(prefix, index);
          walk(items, path, entry, seenRefs);
        });
      }
    } else if (items !== undefined && typeof items !== "boolean") {
      complete = false;
    }

    for (const unsupportedKeyword of [
      "$dynamicRef",
      "contains",
      "dependentSchemas",
      "if",
      "then",
      "else",
      "not",
      "prefixItems",
      "unevaluatedItems",
      "unevaluatedProperties",
    ] as const) {
      if (node[unsupportedKeyword] !== undefined) complete = false;
    }
  }

  walk(rootSchema, "", config, new Set());
  return {
    paths,
    inspectable: complete && sawInspectableStructure,
  };
}

export function collectSecretRefPaths(
  schema: Record<string, unknown> | null | undefined,
  config?: Record<string, unknown>,
): Set<string> {
  return inspectSecretRefPaths(schema, config).paths;
}

export type ConfigResourceScopes = Readonly<
  Record<string, string | null | undefined>
>;

type RuntimeArrayScope = {
  resource: string;
  field: string;
  fallback: "first" | null;
};

function readRuntimeArrayScope(node: Record<string, unknown>): RuntimeArrayScope | null {
  const value = node["x-paperclip-runtime-scope"];
  if (!isPlainRecord(value)) return null;
  const resource = typeof value.resource === "string" ? value.resource.trim() : "";
  const field = typeof value.field === "string" ? value.field.trim() : "";
  if (
    !resource
    || !field
    || SCHEMA_REF_PROTOTYPE_KEYS.has(field)
    || (value.fallback !== undefined && value.fallback !== "first")
  ) {
    return null;
  }
  return {
    resource,
    field,
    fallback: value.fallback === "first" ? "first" : null,
  };
}

function scopedResourceArrayIndexes(
  entries: unknown[],
  scope: RuntimeArrayScope,
  resourceScopes: ConfigResourceScopes,
): Set<number> {
  const resourceId = resourceScopes[scope.resource];
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    return new Set(scope.fallback === "first" && entries.length > 0 ? [0] : []);
  }
  return new Set(entries.flatMap((entry, index) =>
    isPlainRecord(entry)
      && entry[scope.field] === resourceId
      ? [index]
      : [],
  ));
}

/**
 * Narrows arrays explicitly marked with `x-paperclip-runtime-scope`.
 *
 * Runtime callers supply the active resource identity (for example the agent
 * running a sandbox). A schema may opt an identity-free flow into a first-row
 * fallback for providers whose probe contract explicitly uses that row. A
 * supplied identity with no matching row produces an empty array.
 * Unselected entries remain sparse until the caller finishes resolving refs,
 * preserving their original indexes for config-path binding checks.
 */
export function scopeConfigResourceArrays(
  schema: Record<string, unknown> | null | undefined,
  config: Record<string, unknown>,
  resourceScopes: ConfigResourceScopes = {},
): Record<string, unknown> {
  const scoped = structuredClone(config) as Record<string, unknown>;
  if (!schema || typeof schema !== "object") return scoped;
  const rootSchema = schema;

  function walk(
    node: Record<string, unknown>,
    value: unknown,
    path: string,
    seenRefs: ReadonlySet<string>,
  ): void {
    const visitedKeys = new Set<string>();
    const ref = node.$ref;
    if (typeof ref === "string") {
      const refAtPath = `${ref}\u0000${path}`;
      if (!seenRefs.has(refAtPath)) {
        const resolved = resolveLocalSchemaRef(rootSchema, ref);
        if (resolved) {
          const nextSeenRefs = new Set(seenRefs);
          nextSeenRefs.add(refAtPath);
          walk(resolved, value, path, nextSeenRefs);
        }
      }
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (isPlainRecord(branch)) walk(branch, value, path, seenRefs);
      }
    }

    if (
      Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(node, "x-paperclip-runtime-scope")
    ) {
      const runtimeScope = readRuntimeArrayScope(node);
      const retainedIndexes = runtimeScope
        ? scopedResourceArrayIndexes(value, runtimeScope, resourceScopes)
        : new Set<number>();
      value.forEach((_entry, index) => {
        if (!retainedIndexes.has(index)) value[index] = undefined;
      });
    }

    if (isPlainRecord(node.properties) && isPlainRecord(value)) {
      for (const [key, propertySchema] of Object.entries(node.properties)) {
        if (!isPlainRecord(propertySchema) || !Object.prototype.hasOwnProperty.call(value, key)) {
          continue;
        }
        visitedKeys.add(key);
        walk(propertySchema, value[key], joinConfigPath(path, key), seenRefs);
      }
    }

    if (isPlainRecord(node.patternProperties) && isPlainRecord(value)) {
      for (const [pattern, propertySchema] of Object.entries(node.patternProperties)) {
        if (!isPlainRecord(propertySchema)) continue;
        let matcher: RegExp;
        try {
          matcher = new RegExp(pattern);
        } catch {
          continue;
        }
        for (const key of Object.keys(value)) {
          if (!matcher.test(key)) continue;
          visitedKeys.add(key);
          walk(propertySchema, value[key], joinConfigPath(path, key), seenRefs);
        }
      }
    }

    if (isPlainRecord(node.additionalProperties) && isPlainRecord(value)) {
      for (const key of Object.keys(value)) {
        if (visitedKeys.has(key)) continue;
        walk(node.additionalProperties, value[key], joinConfigPath(path, key), seenRefs);
      }
    }

    const items = node.items;
    if (isPlainRecord(items) && Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry === undefined) return;
        walk(items, entry, joinConfigPath(path, index), seenRefs);
      });
    } else if (Array.isArray(items) && Array.isArray(value)) {
      items.forEach((itemSchema, index) => {
        if (isPlainRecord(itemSchema) && index < value.length) {
          walk(itemSchema, value[index], joinConfigPath(path, index), seenRefs);
        }
      });
      if (isPlainRecord(node.additionalItems)) {
        for (let index = items.length; index < value.length; index += 1) {
          walk(
            node.additionalItems,
            value[index],
            joinConfigPath(path, index),
            seenRefs,
          );
        }
      }
    }
  }

  walk(rootSchema, scoped, "", new Set());
  return scoped;
}

function readPathSegment(container: unknown, key: string): unknown {
  if (Array.isArray(container)) {
    return /^\d+$/.test(key) ? container[Number(key)] : undefined;
  }
  if (!container || typeof container !== "object") return undefined;
  return (container as Record<string, unknown>)[key];
}

function writePathSegment(container: unknown, key: string, value: unknown): void {
  if (Array.isArray(container)) {
    if (!/^\d+$/.test(key)) return;
    const index = Number(key);
    if (value === undefined) {
      container[index] = undefined;
    } else {
      container[index] = value;
    }
    return;
  }
  if (!container || typeof container !== "object") return;
  if (value === undefined) {
    delete (container as Record<string, unknown>)[key];
  } else {
    (container as Record<string, unknown>)[key] = value;
  }
}

export function readConfigValueAtPath(
  config: Record<string, unknown>,
  dotPath: string,
): unknown {
  let current: unknown = config;
  for (const key of splitConfigPath(dotPath)) {
    current = readPathSegment(current, key);
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
  const keys = splitConfigPath(dotPath);
  let cursor: unknown = result;

  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    let next = readPathSegment(cursor, key);
    if (!next || typeof next !== "object") {
      next = /^\d+$/.test(keys[index + 1]!) ? [] : {};
      writePathSegment(cursor, key, next);
    }
    cursor = next;
  }

  writePathSegment(cursor, keys[keys.length - 1]!, value);
  return result;
}

function compactUndefinedArrayEntries(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined)
      .map((entry) => compactUndefinedArrayEntries(entry));
  }
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, compactUndefinedArrayEntries(entry)]),
  );
}

export function compactConfigArrays(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return compactUndefinedArrayEntries(config) as Record<string, unknown>;
}
