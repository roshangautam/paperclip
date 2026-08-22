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

const SCHEMA_ARRAY_APPLICATORS = ["allOf", "anyOf", "oneOf"] as const;
const SCHEMA_SINGLE_APPLICATORS = ["not", "if", "then", "else"] as const;
const SCHEMA_MAP_APPLICATORS = ["properties", "patternProperties", "$defs", "definitions"] as const;
const SCHEMA_VALUE_APPLICATORS = ["additionalProperties", "additionalItems", "contains"] as const;

export class InvalidSecretRefSchemaPathError extends Error {
  constructor(propertyName: string) {
    super(
      propertyName
        ? `Secret-ref schema property "${propertyName}" cannot contain a dot.`
        : "Secret-ref schema property names cannot be empty.",
    );
    this.name = "InvalidSecretRefSchemaPathError";
  }
}

export class InvalidSecretRefSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSecretRefSchemaError";
  }
}

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
    resourceScope: Record<string, unknown>,
    seen: Set<unknown> = new Set(),
  ): Record<string, unknown> | null {
    if (!isRecord(node) || seen.has(node)) return null;
    seen.add(node);
    // Fragment-only references must not search through a nested schema
    // resource. That resource owns its anchors and can reuse the same name as
    // the parent resource without changing what this reference resolves to.
    if (node !== resourceScope && typeof node.$id === "string" && !node.$id.startsWith("#")) {
      return null;
    }
    if (predicate(node)) return node;

    const children: unknown[] = [];
    for (const keyword of SCHEMA_ARRAY_APPLICATORS) {
      const branches = node[keyword];
      if (Array.isArray(branches)) children.push(...branches);
    }
    for (const keyword of SCHEMA_SINGLE_APPLICATORS) {
      if (node[keyword] !== undefined) children.push(node[keyword]);
    }
    for (const keyword of SCHEMA_MAP_APPLICATORS) {
      const schemas = node[keyword];
      if (isRecord(schemas)) children.push(...Object.values(schemas));
    }
    if (isRecord(node.dependencies)) {
      children.push(...Object.values(node.dependencies).filter((dependency) => !Array.isArray(dependency)));
    }
    if (Array.isArray(node.items)) children.push(...node.items);
    else if (node.items !== undefined) children.push(node.items);
    for (const keyword of SCHEMA_VALUE_APPLICATORS) {
      if (node[keyword] !== undefined) children.push(node[keyword]);
    }
    for (const child of children) {
      const found = findSchemaNode(child, predicate, resourceScope, seen);
      if (found) return found;
    }
    return null;
  }

  function resolveLocalSchemaRef(
    ref: string,
    resourceScope: Record<string, unknown>,
  ): Record<string, unknown> | null {
    let decodedRef: string;
    try {
      decodedRef = decodeURIComponent(ref);
    } catch {
      return null;
    }
    // A fragment-only ref is scoped to the nearest JSON Schema resource. A
    // nested `$id` creates such a resource, so resolving it from the document
    // root can miss a nested `$defs` secret declaration and persist its value
    // raw.
    if (decodedRef === "#") return resourceScope;
    if (decodedRef.startsWith("#/")) {
      let current: unknown = resourceScope;
      for (const encodedSegment of decodedRef.slice(2).split("/")) {
        if (!isRecord(current)) return null;
        const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
        if (!Object.prototype.hasOwnProperty.call(current, segment)) {
          return null;
        }
        current = current[segment];
      }
      return isRecord(current) ? current : null;
    }
    if (!decodedRef.startsWith("#")) return null;
    const anchor = decodedRef.slice(1);
    return findSchemaNode(resourceScope, (candidate) =>
      candidate.$anchor === anchor
      || candidate.$dynamicAnchor === anchor
      || candidate.$id === decodedRef,
    resourceScope);
  }

  function schemaDeclaresSecretRef(
    node: Record<string, unknown>,
    resourceScope: Record<string, unknown>,
    seen: Set<Record<string, unknown>> = new Set(),
  ): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    const currentResourceScope = typeof node.$id === "string" && !node.$id.startsWith("#")
      ? node
      : resourceScope;
    if (node.format === "secret-ref") return true;

    if (typeof node.$ref === "string") {
      const resolved = resolveLocalSchemaRef(node.$ref, currentResourceScope);
      if (!resolved) {
        throw new InvalidSecretRefSchemaError(
          `Unsupported secret-ref schema reference "${node.$ref}"`,
        );
      }
      if (schemaDeclaresSecretRef(resolved, currentResourceScope, seen)) return true;
    }

    const childSchemas: unknown[] = [];
    for (const keyword of SCHEMA_ARRAY_APPLICATORS) {
      const branches = node[keyword];
      if (Array.isArray(branches)) childSchemas.push(...branches);
    }
    for (const keyword of SCHEMA_SINGLE_APPLICATORS) {
      if (node[keyword] !== undefined) childSchemas.push(node[keyword]);
    }
    for (const keyword of SCHEMA_MAP_APPLICATORS) {
      const schemas = node[keyword];
      if (isRecord(schemas)) childSchemas.push(...Object.values(schemas));
    }
    if (isRecord(node.dependencies)) {
      childSchemas.push(...Object.values(node.dependencies).filter((dependency) => !Array.isArray(dependency)));
    }
    if (Array.isArray(node.items)) childSchemas.push(...node.items);
    else if (node.items !== undefined) childSchemas.push(node.items);
    for (const keyword of SCHEMA_VALUE_APPLICATORS) {
      if (node[keyword] !== undefined) childSchemas.push(node[keyword]);
    }

    return childSchemas.some((child) =>
      isRecord(child) && schemaDeclaresSecretRef(child, currentResourceScope, seen));
  }

  const refValueIds = new Map<object, number>();
  let nextRefValueId = 1;

  function refValueKey(
    ref: string,
    value: unknown,
    resourceScope: Record<string, unknown>,
  ): string {
    let scopeId = refValueIds.get(resourceScope);
    if (scopeId === undefined) {
      scopeId = nextRefValueId;
      nextRefValueId += 1;
      refValueIds.set(resourceScope, scopeId);
    }
    const prefix = `${scopeId}\u0000${ref}\u0000`;
    if (value && typeof value === "object") {
      let id = refValueIds.get(value);
      if (id === undefined) {
        id = nextRefValueId;
        nextRefValueId += 1;
        refValueIds.set(value, id);
      }
      return `${prefix}object:${id}`;
    }
    return `${prefix}${typeof value}:${String(value)}`;
  }

  function walk(
    node: Record<string, unknown>,
    prefix: string,
    value: unknown,
    seenRefs: ReadonlySet<string> = new Set(),
    resourceScope: Record<string, unknown> = schema!,
  ): boolean {
    const currentResourceScope = typeof node.$id === "string" && !node.$id.startsWith("#")
      ? node
      : resourceScope;
    let declaresSecretPath = false;
    if (isRecord(node.contains) && schemaDeclaresSecretRef(node.contains, currentResourceScope)) {
      throw new InvalidSecretRefSchemaError(
        'Secret-ref schema cannot declare secret refs through conditional keyword "contains"',
      );
    }
    if (node.format === "secret-ref") {
      if (!prefix) {
        throw new InvalidSecretRefSchemaPathError(prefix);
      }
      paths.add(prefix);
      declaresSecretPath = true;
    }

    const ref = node.$ref;
    if (typeof ref === "string") {
      const refAtValue = refValueKey(ref, value, currentResourceScope);
      if (!seenRefs.has(refAtValue)) {
        const resolved = resolveLocalSchemaRef(ref, currentResourceScope);
        if (!resolved) {
          throw new InvalidSecretRefSchemaError(
            `Unsupported secret-ref schema reference "${ref}"`,
          );
        }
        const nextSeenRefs = new Set(seenRefs);
        nextSeenRefs.add(refAtValue);
        declaresSecretPath = walk(resolved, prefix, value, nextSeenRefs, currentResourceScope)
          || declaresSecretPath;
      }
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!isRecord(branch)) continue;
        declaresSecretPath = walk(branch, prefix, value, seenRefs, currentResourceScope)
          || declaresSecretPath;
      }
    }

    if (Array.isArray(value)) {
      // `additionalItems` applies only to tuple-form `items`, never on its own
      // or alongside a homogeneous item schema (JSON Schema draft-07).
      const tupleItems = Array.isArray(node.items) ? node.items : null;
      const sharedItems = isRecord(node.items) ? node.items : null;
      const additionalItems = tupleItems && isRecord(node.additionalItems) ? node.additionalItems : null;
      value.forEach((item, index) => {
        const itemSchema = tupleItems?.[index]
          ?? sharedItems
          ?? (tupleItems && index >= tupleItems.length ? additionalItems : null);
        if (!isRecord(itemSchema)) return;
        declaresSecretPath = walk(
          itemSchema,
          prefix ? `${prefix}.${index}` : String(index),
          item,
          seenRefs,
          currentResourceScope,
        ) || declaresSecretPath;
      });
    }

    if (isRecord(value) && isRecord(node.dependencies)) {
      for (const [key, dependentSchema] of Object.entries(node.dependencies)) {
        if (!Object.prototype.hasOwnProperty.call(value, key) || Array.isArray(dependentSchema)) {
          continue;
        }
        if (dependentSchema === true || dependentSchema === false) continue;
        if (!isRecord(dependentSchema)) {
          throw new InvalidSecretRefSchemaError(
            `Unsupported secret-ref schema dependency "${key}"`,
          );
        }
        declaresSecretPath = walk(
          dependentSchema,
          prefix,
          value,
          seenRefs,
          currentResourceScope,
        ) || declaresSecretPath;
      }
    }

    if (!isRecord(value) && config !== undefined) return declaresSecretPath;
    const properties = isRecord(node.properties) ? node.properties : {};
    const visitedKeys = new Set<string>();
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!isRecord(propertySchema)) continue;
      const propertyValue = readChild(value, key);
      // Config-aware callers need only concrete paths. Besides avoiding stale
      // optional bindings, this stops recursive refs once the value tree ends.
      if (config !== undefined && propertyValue === undefined) continue;
      visitedKeys.add(key);
      const path = prefix ? `${prefix}.${key}` : key;
      const propertyDeclaresSecretPath = walk(
        propertySchema,
        path,
        propertyValue,
        seenRefs,
        currentResourceScope,
      );
      declaresSecretPath = propertyDeclaresSecretPath || declaresSecretPath;
      // Dot paths are the durable representation used by every secret-ref
      // reader, writer, audit record, and binding. JSON Schema property names
      // may contain dots, but such a name would make a discovered secret path
      // lossy (for example `api.token` becomes two path segments). Reject the
      // configuration before a raw secret could be persisted under that key.
      // Do not infer this from the global path set: a preceding nested property
      // can already have added the same lossy path.
      if ((key.includes(".") || key.length === 0) && propertyDeclaresSecretPath) {
        throw new InvalidSecretRefSchemaPathError(key);
      }
    }

    if (!isRecord(value)) return declaresSecretPath;
    const patternProperties = isRecord(node.patternProperties) ? node.patternProperties : {};
    for (const [pattern, propertySchema] of Object.entries(patternProperties)) {
      if (!isRecord(propertySchema)) continue;
      let matcher: RegExp;
      try {
        matcher = new RegExp(pattern);
      } catch {
        continue;
      }
      for (const [key, propertyValue] of Object.entries(value)) {
        if (!matcher.test(key)) continue;
        visitedKeys.add(key);
        const path = prefix ? `${prefix}.${key}` : key;
        const propertyDeclaresSecretPath = walk(
          propertySchema,
          path,
          propertyValue,
          seenRefs,
          currentResourceScope,
        );
        declaresSecretPath = propertyDeclaresSecretPath || declaresSecretPath;
        if ((key.includes(".") || key.length === 0) && propertyDeclaresSecretPath) {
          throw new InvalidSecretRefSchemaPathError(key);
        }
      }
    }

    if (isRecord(node.additionalProperties)) {
      for (const [key, propertyValue] of Object.entries(value)) {
        if (visitedKeys.has(key)) continue;
        const path = prefix ? `${prefix}.${key}` : key;
        const propertyDeclaresSecretPath = walk(
          node.additionalProperties,
          path,
          propertyValue,
          seenRefs,
          currentResourceScope,
        );
        declaresSecretPath = propertyDeclaresSecretPath || declaresSecretPath;
        if ((key.includes(".") || key.length === 0) && propertyDeclaresSecretPath) {
          throw new InvalidSecretRefSchemaPathError(key);
        }
      }
    }
    return declaresSecretPath;
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
