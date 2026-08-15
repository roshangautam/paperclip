import { redactCommandText } from "@paperclipai/adapter-utils";
import { encodeConfigPathSegment } from "./services/json-schema-secret-refs.js";

const SECRET_FIELD_NAME_PATTERN =
  String.raw`[A-Za-z0-9_-]*(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|token|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)[A-Za-z0-9_-]*`;

const SECRET_PAYLOAD_KEY_RE = new RegExp(SECRET_FIELD_NAME_PATTERN, "i");
const COMMAND_PAYLOAD_KEY_RE =
  /(^command$|^cmd$|command[-_]?line|resolved[-_]?command|PAPERCLIP_RESOLVED_COMMAND)/i;
const COMMAND_ARGS_PAYLOAD_KEY_RE = /^(commandArgs|command_?args|argv)$/i;
const JWT_VALUE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/;
const CLI_SECRET_FLAG_RE = new RegExp(String.raw`^-{1,2}${SECRET_FIELD_NAME_PATTERN}$`, "i");
const JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:"|')?${SECRET_FIELD_NAME_PATTERN}(?:"|')?\s*:\s*(?:"|'))[^"'` + "`" + String.raw`\r\n]+((?:"|'))`,
  "gi",
);
const ESCAPED_JSON_SECRET_FIELD_TEXT_RE = new RegExp(
  String.raw`((?:\\")?${SECRET_FIELD_NAME_PATTERN}(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))`,
  "gi",
);
const SECRET_TEXT_HINTS = [
  "api",
  "key",
  "token",
  "auth",
  "bearer",
  "secret",
  "pass",
  "credential",
  "jwt",
  "private",
  "cookie",
  "connectionstring",
  "sk-",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
] as const;
export const REDACTED_EVENT_VALUE = "***REDACTED***";

function maybeContainsSecretText(input: string) {
  const lower = input.toLowerCase();
  return SECRET_TEXT_HINTS.some((hint) => lower.includes(hint)) || input.includes(".");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (isSecretRefBinding(value)) return value;
  if (isUserSecretRefBinding(value)) return value;
  if (isPlainBinding(value)) return { type: "plain", value: sanitizeValue(value.value) };
  if (!isPlainObject(value)) return value;
  return sanitizeRecord(value);
}

function isSecretRefBinding(value: unknown): value is { type: "secret_ref"; secretId: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "secret_ref" && typeof value.secretId === "string";
}

function isUserSecretRefBinding(value: unknown): value is { type: "user_secret_ref"; key: string; version?: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "user_secret_ref" && typeof value.key === "string";
}

function isPlainBinding(value: unknown): value is { type: "plain"; value: unknown } {
  if (!isPlainObject(value)) return false;
  return value.type === "plain" && "value" in value;
}

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_EVENT_VALUE;
    }
    if (typeof arg !== "string") return sanitizeValue(arg);
    if (CLI_SECRET_FLAG_RE.test(arg.trim())) {
      redactNext = true;
      return arg;
    }
    return redactSensitiveText(arg);
  });
}

export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (COMMAND_ARGS_PAYLOAD_KEY_RE.test(key) && Array.isArray(value)) {
      redacted[key] = sanitizeCommandArgs(value);
      continue;
    }
    if (COMMAND_PAYLOAD_KEY_RE.test(key) && typeof value === "string") {
      redacted[key] = redactSensitiveText(value);
      continue;
    }
    if (SECRET_PAYLOAD_KEY_RE.test(key)) {
      if (isSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isUserSecretRefBinding(value)) {
        redacted[key] = sanitizeValue(value);
        continue;
      }
      if (isPlainBinding(value)) {
        redacted[key] = { type: "plain", value: REDACTED_EVENT_VALUE };
        continue;
      }
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    if (typeof value === "string" && JWT_VALUE_RE.test(value)) {
      redacted[key] = REDACTED_EVENT_VALUE;
      continue;
    }
    redacted[key] = sanitizeValue(value);
  }
  return redacted;
}

export function redactEventPayload(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!payload) return null;
  if (!isPlainObject(payload)) return payload;
  return sanitizeRecord(payload);
}

// An identifier-reference key is a whole identifier word (`id`, `name`, ...), a
// delimiter-suffixed form (`user_id`, `TOKEN_ID`), or a genuine camelCase suffix
// (`agentId`, `sandboxId`). Plain words that merely end in those letters — e.g.
// `valid`, `hybrid`, `solid` — are NOT identifiers, so a credential-shaped parent
// no longer preserves a nested `{ valid: "secret" }` value.
const IDENTIFIER_WORD_OR_DELIMITED_KEY_RE = /(?:^|[-_])(?:id|name|ref|path|url|uri|host)$/i;
const IDENTIFIER_CAMEL_SUFFIX_KEY_RE = /[a-z](?:Id|Name|Ref|Path|Url|Uri|Host)$/;

const SENSITIVE_REFERENCE_IDENTIFIER_KEY_RE = /(?:^|[-_])(?:id|ref)$|[a-z](?:Id|Ref)$/;

function isIdentifierReferenceKey(key: string): boolean {
  return IDENTIFIER_WORD_OR_DELIMITED_KEY_RE.test(key) || IDENTIFIER_CAMEL_SUFFIX_KEY_RE.test(key);
}

function preservesIdentifierValue(key: string): boolean {
  return isIdentifierReferenceKey(key)
    && !(SECRET_PAYLOAD_KEY_RE.test(key) && SENSITIVE_REFERENCE_IDENTIFIER_KEY_RE.test(key));
}

export function redactPersistedCredentialValues(
  value: unknown,
  options: { preserveContainerPaths?: ReadonlySet<string> } = {},
): unknown {
  const preserveContainerPaths = options.preserveContainerPaths ?? new Set<string>();

  function visit(current: unknown, path: string, inheritedSensitive: boolean, key: string | null): unknown {
    if (current === null || current === undefined) return current;
    if (Array.isArray(current)) {
      return current.map((entry, index) =>
        visit(entry, path ? `${path}.${index}` : String(index), inheritedSensitive, null),
      );
    }
    if (isPlainObject(current)) {
      const result: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(current)) {
        const childPath = path ? `${path}.${encodeConfigPathSegment(childKey)}` : encodeConfigPathSegment(childKey);
        if (preserveContainerPaths.has(childPath)) {
          result[childKey] = childValue;
          continue;
        }
        const sensitiveKey = SECRET_PAYLOAD_KEY_RE.test(childKey)
          && !preservesIdentifierValue(childKey);
        result[childKey] = visit(
          childValue,
          childPath,
          inheritedSensitive || sensitiveKey,
          childKey,
        );
      }
      return result;
    }
    if (typeof current === "string" && JWT_VALUE_RE.test(current)) return REDACTED_EVENT_VALUE;
    if (key !== null && preservesIdentifierValue(key)) return current;
    if (key !== null && SECRET_PAYLOAD_KEY_RE.test(key)) return REDACTED_EVENT_VALUE;
    if (inheritedSensitive) return REDACTED_EVENT_VALUE;
    return current;
  }

  return visit(value, "", false, null);
}

export function redactSensitiveText(input: string): string {
  if (!maybeContainsSecretText(input)) return input;
  return redactCommandText(
    input
      .replace(JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`)
      .replace(ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${REDACTED_EVENT_VALUE}$2`),
    REDACTED_EVENT_VALUE,
  );
}
