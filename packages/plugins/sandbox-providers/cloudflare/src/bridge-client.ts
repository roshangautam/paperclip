import type {
  CloudflareBridgeAcquireLeaseRequest,
  CloudflareBridgeDestroyLeaseRequest,
  CloudflareBridgeExecuteRequest,
  CloudflareBridgeExecuteResponse,
  CloudflareBridgeHealthResponse,
  CloudflareBridgeLeaseResponse,
  CloudflareBridgeProbeRequest,
  CloudflareBridgeProbeResponse,
  CloudflareBridgeReleaseLeaseRequest,
  CloudflareBridgeResumeLeaseRequest,
  CloudflareDriverConfig,
} from "./types.js";

interface BridgeClientHeaders {
  acquisitionId?: string;
  environmentId?: string;
  runId?: string;
  issueId?: string | null;
}

interface BridgeClientOptions {
  config: CloudflareDriverConfig;
}

interface BridgeExecuteOptions {
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
}

interface BridgeErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
}

const API_PREFIX = "/api/paperclip-sandbox/v1";
const OWNERSHIP_API_PREFIX = "/api/paperclip-sandbox/v2";
const EXEC_REQUEST_CLEANUP_GRACE_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CloudflareBridgeError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(input: { status: number; code?: string | null; message: string; details?: unknown }) {
    super(input.message);
    this.name = "CloudflareBridgeError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.details = input.details;
  }
}

function buildHeaders(config: CloudflareDriverConfig, extra: BridgeClientHeaders = {}): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${config.bridgeAuthToken}`);
  headers.set("Content-Type", "application/json");
  if (extra.acquisitionId) headers.set("X-Paperclip-Acquisition-Id", extra.acquisitionId);
  if (extra.environmentId) headers.set("X-Paperclip-Environment-Id", extra.environmentId);
  if (extra.runId) headers.set("X-Paperclip-Run-Id", extra.runId);
  if (extra.issueId) headers.set("X-Paperclip-Issue-Id", extra.issueId);
  return headers;
}

async function parseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }
  return await response.json();
}

function encodeExecuteRequestBody(body: CloudflareBridgeExecuteRequest, options?: BridgeExecuteOptions): string {
  return JSON.stringify({
    ...body,
    streamOutput: typeof options?.onOutput === "function",
  });
}

function parseExecuteTimeoutMs(body: RequestInit["body"]): number | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body) as { timeoutMs?: unknown };
    const timeoutMs = Number(parsed.timeoutMs);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : null;
  } catch {
    return null;
  }
}

export function resolveRequestTimeoutMs(
  config: CloudflareDriverConfig,
  path: string,
  init: RequestInit,
): number {
  if (!path.endsWith("/exec")) {
    return config.bridgeRequestTimeoutMs;
  }
  const requestedTimeoutMs = parseExecuteTimeoutMs(init.body);
  return requestedTimeoutMs === null
    ? config.bridgeRequestTimeoutMs
    : Math.max(
        config.bridgeRequestTimeoutMs,
        requestedTimeoutMs + EXEC_REQUEST_CLEANUP_GRACE_MS,
      );
}

async function requestJson<T>(
  config: CloudflareDriverConfig,
  path: string,
  init: RequestInit,
  extraHeaders: BridgeClientHeaders = {},
): Promise<T> {
  const controller = new AbortController();
  const requestTimeoutMs = resolveRequestTimeoutMs(config, path, init);
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const baseUrl = config.bridgeBaseUrl.replace(/\/+$/, "");

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: buildHeaders(config, extraHeaders),
      signal: controller.signal,
    });
    const body = await parseJson(response);
    if (!response.ok) {
      const errorBody = isRecord(body) ? body as BridgeErrorBody : {};
      throw new CloudflareBridgeError({
        status: response.status,
        code: typeof errorBody.error === "string" ? errorBody.error : null,
        message:
          response.status === 404 && path.startsWith(`${OWNERSHIP_API_PREFIX}/`)
            ? "Cloudflare sandbox bridge does not support ownership API v2; deploy the current bridge before using leases."
            : typeof errorBody.message === "string" && errorBody.message.trim().length > 0
            ? errorBody.message
            : `Cloudflare sandbox bridge request failed with HTTP ${response.status}.`,
        details: errorBody.details,
      });
    }
    return body as T;
  } catch (error) {
    if (error instanceof CloudflareBridgeError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new Error(
        `Cloudflare sandbox bridge request timed out after ${requestTimeoutMs}ms.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestResponse<T>(
  config: CloudflareDriverConfig,
  path: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  extraHeaders: BridgeClientHeaders = {},
): Promise<T> {
  const controller = new AbortController();
  const requestTimeoutMs = resolveRequestTimeoutMs(config, path, init);
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const baseUrl = config.bridgeBaseUrl.replace(/\/+$/, "");

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: buildHeaders(config, extraHeaders),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await parseJson(response);
      const errorBody = isRecord(body) ? body as BridgeErrorBody : {};
      throw new CloudflareBridgeError({
        status: response.status,
        code: typeof errorBody.error === "string" ? errorBody.error : null,
        message:
          response.status === 404 && path.startsWith(`${OWNERSHIP_API_PREFIX}/`)
            ? "Cloudflare sandbox bridge does not support ownership API v2; deploy the current bridge before using leases."
            : typeof errorBody.message === "string" && errorBody.message.trim().length > 0
            ? errorBody.message
            : `Cloudflare sandbox bridge request failed with HTTP ${response.status}.`,
        details: errorBody.details,
      });
    }
    return await consume(response);
  } catch (error) {
    if (error instanceof CloudflareBridgeError) throw error;
    if ((error as { name?: string } | null)?.name === "AbortError") {
      throw new Error(
        `Cloudflare sandbox bridge request timed out after ${requestTimeoutMs}ms.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

interface ParsedSseEvent {
  event: string;
  data: string;
}

function parseSseChunk(buffer: string): { events: ParsedSseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: ParsedSseEvent[] = [];

  for (const frame of frames) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    events.push({
      event,
      data: dataLines.join("\n"),
    });
  }

  return { events, rest };
}

async function consumeExecuteEventStream(
  response: Response,
  options: BridgeExecuteOptions,
): Promise<CloudflareBridgeExecuteResponse> {
  if (!response.body) {
    throw new Error("Cloudflare sandbox bridge streaming response had no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CloudflareBridgeExecuteResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const parsed = parseSseChunk(done && buffer.length > 0 ? `${buffer}\n\n` : buffer);
    buffer = parsed.rest;

    for (const event of parsed.events) {
      if (event.event === "stdout" || event.event === "stderr") {
        const payload = JSON.parse(event.data) as { data?: unknown };
        const chunk = typeof payload.data === "string" ? payload.data : "";
        if (chunk) {
          await options.onOutput?.(event.event, chunk);
        }
        continue;
      }

      if (event.event === "complete") {
        result = JSON.parse(event.data) as CloudflareBridgeExecuteResponse;
        continue;
      }

      if (event.event === "error") {
        const payload = JSON.parse(event.data) as { error?: unknown };
        const message = typeof payload.error === "string" && payload.error.trim().length > 0
          ? payload.error
          : "Cloudflare sandbox bridge streaming command failed.";
        throw new Error(message);
      }
    }

    if (done) break;
  }

  if (result) return result;
  throw new Error("Cloudflare sandbox bridge streaming response ended without a completion event.");
}

export function createCloudflareBridgeClient(options: BridgeClientOptions) {
  const { config } = options;

  return {
    health(extraHeaders?: BridgeClientHeaders): Promise<CloudflareBridgeHealthResponse> {
      return requestJson<CloudflareBridgeHealthResponse>(config, `${API_PREFIX}/health`, { method: "GET" }, extraHeaders);
    },

    probe(body: CloudflareBridgeProbeRequest, extraHeaders?: BridgeClientHeaders): Promise<CloudflareBridgeProbeResponse> {
      return requestJson<CloudflareBridgeProbeResponse>(
        config,
        `${API_PREFIX}/probe`,
        { method: "POST", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    acquireLease(
      body: CloudflareBridgeAcquireLeaseRequest,
      extraHeaders?: BridgeClientHeaders,
    ): Promise<CloudflareBridgeLeaseResponse> {
      return requestJson<CloudflareBridgeLeaseResponse>(
        config,
        `${OWNERSHIP_API_PREFIX}/leases/acquire`,
        { method: "POST", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    resumeLease(
      body: CloudflareBridgeResumeLeaseRequest,
      extraHeaders?: BridgeClientHeaders,
    ): Promise<CloudflareBridgeLeaseResponse> {
      return requestJson<CloudflareBridgeLeaseResponse>(
        config,
        `${OWNERSHIP_API_PREFIX}/leases/resume`,
        { method: "POST", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    releaseLease(
      body: CloudflareBridgeReleaseLeaseRequest,
      extraHeaders?: BridgeClientHeaders,
    ): Promise<{ ok: true }> {
      return requestJson<{ ok: true }>(
        config,
        `${OWNERSHIP_API_PREFIX}/leases/release`,
        { method: "POST", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    destroyLease(
      body: CloudflareBridgeDestroyLeaseRequest,
      extraHeaders?: BridgeClientHeaders,
    ): Promise<{ ok: true }> {
      return requestJson<{ ok: true }>(
        config,
        `${OWNERSHIP_API_PREFIX}/leases/${encodeURIComponent(body.providerLeaseId)}`,
        { method: "DELETE", body: JSON.stringify(body) },
        extraHeaders,
      );
    },

    execute(
      body: CloudflareBridgeExecuteRequest,
      extraHeaders?: BridgeClientHeaders,
      options?: BridgeExecuteOptions,
    ): Promise<CloudflareBridgeExecuteResponse> {
      const encodedBody = encodeExecuteRequestBody(body, options);
      if (typeof options?.onOutput === "function") {
        return requestResponse(
          config,
          `${OWNERSHIP_API_PREFIX}/exec`,
          { method: "POST", body: encodedBody },
          (response) => consumeExecuteEventStream(response, options),
          extraHeaders,
        );
      }
      return requestJson<CloudflareBridgeExecuteResponse>(
        config,
        `${OWNERSHIP_API_PREFIX}/exec`,
        { method: "POST", body: encodedBody },
        extraHeaders,
      );
    },
  };
}
