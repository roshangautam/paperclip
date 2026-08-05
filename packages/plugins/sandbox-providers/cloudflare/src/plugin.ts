import { createHash } from "node:crypto";
import { definePlugin, JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type {
  PluginLogger,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentExecuteParams,
  PluginEnvironmentExecuteResult,
  PluginEnvironmentLease,
  PluginEnvironmentProbeParams,
  PluginEnvironmentProbeResult,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentRealizeWorkspaceResult,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentValidationResult,
} from "@paperclipai/plugin-sdk";
import { CloudflareBridgeError, createCloudflareBridgeClient } from "./bridge-client.js";
import {
  parseCloudflareDriverConfig,
  validateCloudflareDriverConfig,
} from "./config.js";

const SANDBOX_EXEC_CHANNEL_ENV = "PAPERCLIP_SANDBOX_EXEC_CHANNEL";
const SANDBOX_EXEC_CHANNEL_BRIDGE = "bridge";
const SANDBOX_ACQUISITION_ID_KEY = "sandboxAcquisitionId";
const CLOUDFLARE_EXEC_STDOUT_PREFIX = "[cloudflare exec stdout]";
const CLOUDFLARE_EXEC_STDERR_PREFIX = "[cloudflare exec stderr]";
const ACQUISITION_REPLAY_INITIAL_DELAY_MS = 250;
const ACQUISITION_REPLAY_MAX_DELAY_MS = 5_000;

function isLostLeaseError(error: unknown): boolean {
  return error instanceof CloudflareBridgeError && error.status === 409;
}

function bridgeClientFor(rawConfig: Record<string, unknown>) {
  const config = parseCloudflareDriverConfig(rawConfig);
  return {
    config,
    client: createCloudflareBridgeClient({ config }),
  };
}

function lostLeaseExecuteResult(error: CloudflareBridgeError): PluginEnvironmentExecuteResult {
  return {
    exitCode: 1,
    timedOut: false,
    signal: null,
    stdout: "",
    stderr:
      error.message.trim().length > 0
        ? `${error.message}\n`
        : "Cloudflare sandbox lease is no longer available.\n",
  };
}

function readIssueId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function shouldReplayAcquisition(error: unknown): boolean {
  if (!(error instanceof CloudflareBridgeError)) return true;
  if (error.code === "acquisition_in_progress") return true;
  return error.status >= 500 && error.code !== "acquisition_failed";
}

async function waitForAcquisitionReplay(attempt: number, deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  const delayMs = Math.min(
    ACQUISITION_REPLAY_INITIAL_DELAY_MS * 2 ** (attempt - 1),
    ACQUISITION_REPLAY_MAX_DELAY_MS,
    remainingMs,
  );
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readLeaseAcquisitionId(metadata: Record<string, unknown> | undefined): string | null {
  return readNonEmptyString(metadata?.[SANDBOX_ACQUISITION_ID_KEY])
    ?? readNonEmptyString(metadata?.acquisitionId);
}

function isReusableSandboxLeaseScope(
  value: unknown,
  params: Pick<PluginEnvironmentReleaseLeaseParams, "companyId" | "environmentId">,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope.version === 1
    && scope.companyId === params.companyId
    && scope.environmentId === params.environmentId
    && scope.provider === "cloudflare"
    && readNonEmptyString(scope.executionWorkspaceId) !== null
    && readNonEmptyString(scope.agentId) !== null
    && (scope.adapterType === null || readNonEmptyString(scope.adapterType) !== null)
    && readNonEmptyString(scope.runtimeFingerprint) !== null;
}

function buildReuseScopeId(params: PluginEnvironmentAcquireLeaseParams): string {
  const agentId = readNonEmptyString(params.agentId);
  const executionWorkspaceId = readNonEmptyString(params.executionWorkspaceId);
  const identity = agentId && executionWorkspaceId
    ? {
        agentId,
        executionWorkspaceId,
        workspaceMode: readNonEmptyString(params.workspaceMode),
        adapterType: readNonEmptyString(params.adapterType),
      }
    : {
        // Older hosts did not supply workspace identity. Keep those calls safe
        // by sacrificing cross-acquisition reuse instead of sharing a sandbox
        // across unrelated agents.
        acquisitionId: params.acquisitionId,
      };
  return createHash("sha256")
    .update(JSON.stringify({
      provider: "cloudflare",
      companyId: params.companyId,
      environmentId: params.environmentId,
      ...identity,
    }))
    .digest("hex")
    .slice(0, 32);
}

function resolveWorkspaceIssueId(params: PluginEnvironmentRealizeWorkspaceParams): string | null {
  const directIssueId = readIssueId(params.issueId);
  if (directIssueId) return directIssueId;

  const request = params.workspace.metadata?.workspaceRealizationRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  return readIssueId((request as { issueId?: unknown }).issueId);
}

function wrapWorkspacePreparationError(remoteCwd: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to prepare Cloudflare sandbox workspace at ${remoteCwd}: ${message}`);
}

function resolveRemoteCwd(
  config: ReturnType<typeof parseCloudflareDriverConfig>,
  params: PluginEnvironmentRealizeWorkspaceParams,
): string {
  const leaseRemoteCwd =
    typeof params.lease.metadata?.remoteCwd === "string" && params.lease.metadata.remoteCwd.trim().length > 0
      ? params.lease.metadata.remoteCwd.trim()
      : null;
  return leaseRemoteCwd ?? params.workspace.remotePath ?? params.workspace.localPath ?? config.requestedCwd;
}

function resolveExecuteSession(
  config: ReturnType<typeof parseCloudflareDriverConfig>,
  env: Record<string, string> | undefined,
) {
  if (env?.[SANDBOX_EXEC_CHANNEL_ENV] !== SANDBOX_EXEC_CHANNEL_BRIDGE) {
    return {
      sessionStrategy: config.sessionStrategy,
      sessionId: config.sessionId,
    } as const;
  }

  const baseSessionId = config.sessionId.trim().length > 0 ? config.sessionId : "paperclip";
  return {
    sessionStrategy: "named" as const,
    sessionId: `${baseSessionId}-bridge`,
  };
}

function sanitizeExecuteEnv(env: Record<string, string> | undefined) {
  if (!env || !(SANDBOX_EXEC_CHANNEL_ENV in env)) {
    return env;
  }
  const nextEnv = { ...env };
  delete nextEnv[SANDBOX_EXEC_CHANNEL_ENV];
  return nextEnv;
}

function logCloudflareExecChunk(
  logger: PluginLogger | null,
  stream: "stdout" | "stderr",
  chunk: string,
) {
  if (!logger || chunk.length === 0) return;
  const lines = chunk
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    if (stream === "stderr") {
      logger.warn(`${CLOUDFLARE_EXEC_STDERR_PREFIX} ${line}`);
    } else {
      logger.info(`${CLOUDFLARE_EXEC_STDOUT_PREFIX} ${line}`);
    }
  }
}

let pluginLogger: PluginLogger | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginLogger = ctx.logger;
    ctx.logger.info("Cloudflare sandbox provider plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Cloudflare sandbox provider plugin healthy" };
  },

  async onEnvironmentValidateConfig(
    params: PluginEnvironmentValidateConfigParams,
  ): Promise<PluginEnvironmentValidationResult> {
    const config = parseCloudflareDriverConfig(params.config);
    const errors = validateCloudflareDriverConfig(config);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return {
      ok: true,
      normalizedConfig: { ...config },
    };
  },

  async onEnvironmentProbe(
    params: PluginEnvironmentProbeParams,
  ): Promise<PluginEnvironmentProbeResult> {
    const { config, client } = bridgeClientFor(params.config);
    try {
      const result = await client.probe(
        {
          requestedCwd: config.requestedCwd,
          keepAlive: config.keepAlive,
          sleepAfter: config.sleepAfter,
          normalizeId: config.normalizeId,
          sessionStrategy: config.sessionStrategy,
          sessionId: config.sessionId,
          timeoutMs: config.timeoutMs,
        },
        { environmentId: params.environmentId, issueId: params.issueId },
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: "Cloudflare sandbox bridge probe failed.",
        metadata: {
          provider: "cloudflare",
          error: message,
        },
      };
    }
  },

  async onEnvironmentAcquireLease(
    params: PluginEnvironmentAcquireLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const { config, client } = bridgeClientFor(params.config);
    const health = await client.health({
      acquisitionId: params.acquisitionId,
      environmentId: params.environmentId,
      runId: params.runId,
      issueId: params.issueId,
    });
    if (health.capabilities?.acquisitionReplay !== true) {
      throw new Error(
        "Cloudflare sandbox bridge does not support replay-safe lease acquisition; deploy the current bridge before acquiring leases.",
      );
    }
    if (config.reuseLease && health.capabilities?.scopedReuse !== true) {
      throw new Error(
        "Cloudflare sandbox bridge does not support workspace-scoped reusable leases; deploy the current bridge before enabling reuseLease.",
      );
    }
    const reuseScopeId = config.reuseLease ? buildReuseScopeId(params) : undefined;
    const acquisitionRequest = {
      acquisitionId: params.acquisitionId,
      environmentId: params.environmentId,
      reuseScopeId,
      runId: params.runId,
      issueId: params.issueId,
      reuseLease: config.reuseLease,
      keepAlive: config.keepAlive,
      sleepAfter: config.sleepAfter,
      normalizeId: config.normalizeId,
      requestedCwd: params.requestedCwd?.trim() || config.requestedCwd,
      sessionStrategy: config.sessionStrategy,
      sessionId: config.sessionId,
      timeoutMs: config.timeoutMs,
    };
    const acquisitionHeaders = {
      acquisitionId: params.acquisitionId,
      environmentId: params.environmentId,
      runId: params.runId,
      issueId: params.issueId,
    };
    let replayDeadline: number | null = null;
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await client.acquireLease(acquisitionRequest, acquisitionHeaders);
        } catch (error) {
          if (!shouldReplayAcquisition(error)) {
            throw error;
          }
          replayDeadline ??= Date.now() + Math.max(config.timeoutMs, config.bridgeRequestTimeoutMs);
          if (Date.now() >= replayDeadline) throw error;
          await waitForAcquisitionReplay(attempt, replayDeadline);
        }
      }
    } catch (error) {
      if (error instanceof CloudflareBridgeError) {
        const providerLeaseId = typeof (error.details as { providerLeaseId?: unknown } | null)?.providerLeaseId === "string"
          ? (error.details as { providerLeaseId: string }).providerLeaseId.trim()
          : "";
        if (providerLeaseId) {
          throw new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
            message: error.message,
            data: { providerLeaseId },
          });
        }
      }
      throw error;
    }
  },

  async onEnvironmentResumeLease(
    params: PluginEnvironmentResumeLeaseParams,
  ): Promise<PluginEnvironmentLease> {
    const { config, client } = bridgeClientFor(params.config);
    const acquisitionId = readLeaseAcquisitionId(params.leaseMetadata);
    try {
      // Avoid a separate health request; the resume response itself proves
      // whether the bridge supports replay-safe ownership metadata.
      const resumed = await client.resumeLease(
        {
          providerLeaseId: params.providerLeaseId,
          acquisitionId: acquisitionId ?? undefined,
          requestedCwd:
            typeof params.leaseMetadata?.remoteCwd === "string" && params.leaseMetadata.remoteCwd.trim().length > 0
              ? params.leaseMetadata.remoteCwd.trim()
              : config.requestedCwd,
          sessionStrategy: config.sessionStrategy,
          sessionId: config.sessionId,
          keepAlive: config.keepAlive,
          sleepAfter: config.sleepAfter,
          normalizeId: config.normalizeId,
          timeoutMs: config.timeoutMs,
        },
        { environmentId: params.environmentId, issueId: params.issueId },
      );
      const resumedAcquisitionId = readLeaseAcquisitionId(resumed.metadata);
      if (!resumedAcquisitionId) {
        throw new Error(
          "Cloudflare sandbox bridge resume response is missing lease ownership metadata; deploy the current bridge before resuming leases.",
        );
      }
      if (resumed.providerLeaseId !== params.providerLeaseId) {
        throw new Error("Cloudflare sandbox bridge resumed a different provider lease.");
      }
      if (acquisitionId && resumedAcquisitionId !== acquisitionId) {
        throw new Error("Cloudflare sandbox bridge resumed a different lease acquisition.");
      }
      return resumed;
    } catch (error) {
      if (isLostLeaseError(error)) {
        return {
          providerLeaseId: null,
          metadata: {
            provider: "cloudflare",
            expired: true,
          },
        };
      }
      throw error;
    }
  },

  async onEnvironmentReleaseLease(
    params: PluginEnvironmentReleaseLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const { config, client } = bridgeClientFor(params.config);
    const reuseLease = isReusableSandboxLeaseScope(params.leaseMetadata?.reusableSandboxLease, params);
    if (reuseLease) return;
    const acquisitionId = readLeaseAcquisitionId(params.leaseMetadata);
    await client.releaseLease(
      {
        providerLeaseId: params.providerLeaseId,
        acquisitionId: acquisitionId ?? undefined,
        reuseLease,
        keepAlive: config.keepAlive,
        requestedCwd: readNonEmptyString(params.leaseMetadata?.remoteCwd) ?? config.requestedCwd,
        sessionStrategy: params.leaseMetadata?.sessionStrategy === "default" || params.leaseMetadata?.sessionStrategy === "named"
          ? params.leaseMetadata.sessionStrategy
          : config.sessionStrategy,
        sessionId: readNonEmptyString(params.leaseMetadata?.sessionId) ?? config.sessionId,
        timeoutMs: config.timeoutMs,
      },
      { acquisitionId: acquisitionId ?? undefined, environmentId: params.environmentId, issueId: params.issueId },
    );
  },

  async onEnvironmentDestroyLease(
    params: PluginEnvironmentDestroyLeaseParams,
  ): Promise<void> {
    if (!params.providerLeaseId) return;
    const { config, client } = bridgeClientFor(params.config);
    const acquisitionId = readLeaseAcquisitionId(params.leaseMetadata);
    await client.destroyLease({
      providerLeaseId: params.providerLeaseId,
      acquisitionId: acquisitionId ?? undefined,
      requestedCwd: readNonEmptyString(params.leaseMetadata?.remoteCwd) ?? config.requestedCwd,
      sessionStrategy: params.leaseMetadata?.sessionStrategy === "default" || params.leaseMetadata?.sessionStrategy === "named"
        ? params.leaseMetadata.sessionStrategy
        : config.sessionStrategy,
      sessionId: readNonEmptyString(params.leaseMetadata?.sessionId) ?? config.sessionId,
      timeoutMs: config.timeoutMs,
    }, {
      acquisitionId: acquisitionId ?? undefined,
      environmentId: params.environmentId,
      issueId: params.issueId,
    });
  },

  async onEnvironmentRealizeWorkspace(
    params: PluginEnvironmentRealizeWorkspaceParams,
  ): Promise<PluginEnvironmentRealizeWorkspaceResult> {
    const { config, client } = bridgeClientFor(params.config);
    const remoteCwd = resolveRemoteCwd(config, params);
    const issueId = resolveWorkspaceIssueId(params);

    if (params.lease.providerLeaseId) {
      const acquisitionId = readLeaseAcquisitionId(params.lease.metadata);
      if (!acquisitionId) {
        throw wrapWorkspacePreparationError(
          remoteCwd,
          new Error("Cloudflare sandbox lease ownership metadata is missing."),
        );
      }
      try {
        await client.execute(
          {
            providerLeaseId: params.lease.providerLeaseId,
            acquisitionId,
            command: "mkdir",
            args: ["-p", remoteCwd],
            cwd: "/",
            timeoutMs: config.timeoutMs,
            sessionStrategy: config.sessionStrategy,
            sessionId: config.sessionId,
          },
          { acquisitionId, environmentId: params.environmentId, issueId },
        );
      } catch (error) {
        throw wrapWorkspacePreparationError(remoteCwd, error);
      }
    }

    return {
      cwd: remoteCwd,
      metadata: {
        provider: "cloudflare",
        remoteCwd,
      },
    };
  },

  async onEnvironmentExecute(
    params: PluginEnvironmentExecuteParams,
  ): Promise<PluginEnvironmentExecuteResult> {
    if (!params.lease.providerLeaseId) {
      return {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: "No provider lease ID available for execution.\n",
      };
    }
    const acquisitionId = readLeaseAcquisitionId(params.lease.metadata);
    if (!acquisitionId) {
      return {
        exitCode: 1,
        timedOut: false,
        signal: null,
        stdout: "",
        stderr: "Cloudflare sandbox lease ownership metadata is missing.\n",
      };
    }

    const { config, client } = bridgeClientFor(params.config);
    const session = resolveExecuteSession(config, params.env);
    try {
      // Bridge-channel commands carry machine-consumed stdout (JSON, base64,
      // file contents). The @cloudflare/sandbox SDK's streaming mode can drop
      // the final stdout chunk when the inner shell exits the same tick as it
      // writes (e.g. `cat ready.json && exit 0`), so we never stream for
      // bridge control traffic — only adapter sessions get live log forwarding.
      const isBridgeChannel = params.env?.[SANDBOX_EXEC_CHANNEL_ENV] === SANDBOX_EXEC_CHANNEL_BRIDGE;
      const streamingOptions = pluginLogger && !isBridgeChannel
        ? {
            onOutput: async (stream: "stdout" | "stderr", chunk: string) => {
              logCloudflareExecChunk(pluginLogger, stream, chunk);
            },
          }
        : undefined;
      return await client.execute(
        {
          providerLeaseId: params.lease.providerLeaseId,
          acquisitionId,
          command: params.command,
          args: params.args,
          cwd: params.cwd,
          env: sanitizeExecuteEnv(params.env),
          stdin: params.stdin ?? null,
          timeoutMs: params.timeoutMs ?? config.timeoutMs,
          sessionStrategy: session.sessionStrategy,
          sessionId: session.sessionId,
        },
        { acquisitionId, environmentId: params.environmentId, issueId: params.issueId },
        streamingOptions,
      );
    } catch (error) {
      if (error instanceof CloudflareBridgeError && isLostLeaseError(error)) {
        return lostLeaseExecuteResult(error);
      }
      throw error;
    }
  },
});

export default plugin;
