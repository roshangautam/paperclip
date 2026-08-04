import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvSecretRefBinding } from "@paperclipai/shared";

import { definePlugin } from "../src/define-plugin.js";
import {
  createHostClientHandlers,
  type HostServices,
} from "../src/host-client-factory.js";
import {
  createNotification,
  createRequest,
  createErrorResponse,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JsonRpcCallError,
  parseMessage,
  PLUGIN_RPC_ERROR_CODES,
  serializeMessage,
  type JsonRpcResponse,
  type PluginEnvironmentAcquireLeaseErrorData,
  type PluginInvocationContext,
} from "../src/protocol.js";
import { isWorkerEntrypoint, startWorkerRpcHost } from "../src/worker-rpc-host.js";

describe("isWorkerEntrypoint", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function createTempRoot(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sdk-worker-"));
    tempRoots.push(tempRoot);
    return tempRoot;
  }

  it("matches an entrypoint reached through a symlinked directory", () => {
    const tempRoot = createTempRoot();
    const realDir = path.join(tempRoot, "real");
    const linkDir = path.join(tempRoot, "link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir, "dir");

    const workerPath = path.join(realDir, "worker.js");
    fs.writeFileSync(workerPath, "");

    expect(
      isWorkerEntrypoint(
        path.join(linkDir, "worker.js"),
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(true);
  });

  it("does not match a different entrypoint", () => {
    const tempRoot = createTempRoot();
    const workerPath = path.join(tempRoot, "worker.js");
    const otherPath = path.join(tempRoot, "other.js");
    fs.writeFileSync(workerPath, "");
    fs.writeFileSync(otherPath, "");

    expect(
      isWorkerEntrypoint(
        otherPath,
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(false);
  });
});
describe("worker performAction context", () => {
  it("does not derive context companyId from caller params without host actor context", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("inspect", async (params, context) => ({
          paramsCompanyId: params.companyId,
          actor: context.actor,
          companyId: context.companyId,
        }));
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    try {
      await expect(callWorker("initialize", {
        manifest: {
          id: "paperclip.test-worker-context",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Worker Context Test",
          description: "Test plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: [],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      })).resolves.toMatchObject({ ok: true });

      await expect(callWorker("performAction", {
        key: "inspect",
        params: { companyId: "spoofed-company" },
      })).resolves.toEqual({
        paramsCompanyId: "spoofed-company",
        actor: {
          type: "system",
          userId: null,
          agentId: null,
          runId: null,
          companyId: null,
        },
        companyId: null,
      });
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker structured errors", () => {
  it("preserves acquisition failure data across the worker RPC boundary", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const errorData: PluginEnvironmentAcquireLeaseErrorData = {
      providerLeaseId: "provider-lease-created-before-failure",
    };
    const plugin = definePlugin({
      async setup() {},
      async onEnvironmentAcquireLease() {
        throw new JsonRpcCallError({
          code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
          message: "workspace startup failed after lease creation",
          data: errorData,
        });
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = "host-structured-error";
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new JsonRpcCallError(response.error));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    try {
      const failure = await callWorker("environmentAcquireLease", {
        driverKey: "test-driver",
        companyId: "company-a",
        environmentId: "environment-a",
        config: {},
        acquisitionId: "acquisition-a",
        runId: "run-a",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(JsonRpcCallError);
      expect(failure).toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
        message: "workspace startup failed after lease creation",
        data: errorData,
      });
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker invocation scope propagation", () => {
  it("keeps overlapping company scopes local to each getData invocation", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedInvocationIds: string[] = [];
    const invocationCompanies = new Map([
      ["invocation-a", "company-a"],
      ["invocation-b", "company-b"],
    ]);
    let releaseCompanyA: (() => void) | null = null;
    let nextRequestId = 1;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("probe", async (params) => {
          if (params.label === "a") {
            await new Promise<void>((resolve) => {
              releaseCompanyA = resolve;
            });
          }
          const company = await ctx.companies.get(String(params.requestedCompanyId));
          return { label: params.label, company };
        });
      },
    });

    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown, invocation?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }

      if (!isJsonRpcRequest(message)) return;
      if (message.method !== "companies.get") return;

      const invocationId = (message as { paperclipInvocationId?: string }).paperclipInvocationId ?? "";
      const requestedCompanyId = (message.params as { companyId?: string }).companyId;
      const allowedCompanyId = invocationCompanies.get(invocationId);
      nestedInvocationIds.push(invocationId);
      if (requestedCompanyId !== allowedCompanyId) {
        hostToWorker.write(serializeMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
          `requested company "${requestedCompanyId}" but invocation "${invocationId}" is scoped to "${allowedCompanyId}"`,
        )));
        return;
      }

      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
        id: requestedCompanyId,
      })));

      if (invocationId === "invocation-b") {
        releaseCompanyA?.();
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.scope-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Scope test",
          description: "Scope test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["companies.read"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });

      const companyARequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-a",
          params: { label: "a", requestedCompanyId: "company-b" },
        },
        { id: "invocation-a", scope: { companyId: "company-a" } },
      );
      const companyAExpectation = expect(companyARequest).rejects.toThrow(
        /requested company "company-b"/,
      );
      const companyBRequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-b",
          params: { label: "b", requestedCompanyId: "company-b" },
        },
        { id: "invocation-b", scope: { companyId: "company-b" } },
      );

      await expect(companyBRequest).resolves.toEqual({
        label: "b",
        company: { id: "company-b" },
      });
      await companyAExpectation;

      expect(nestedInvocationIds).toEqual(["invocation-b", "invocation-a"]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("echoes the session notification invocation id from onEvent host calls", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const callbackInvocationIds: string[] = [];
    let nextRequestId = 1;
    let sendSessionMessage: (() => Promise<unknown>) | null = null;
    let resolveCallback!: () => void;
    const callbackComplete = new Promise<void>((resolve) => {
      resolveCallback = resolve;
    });

    const plugin = definePlugin({
      async setup(ctx) {
        sendSessionMessage = () => ctx.agents.sessions.sendMessage(
          "session-1",
          "company-a",
          {
            prompt: "hello",
            onEvent: async () => {
              await ctx.config.get();
              resolveCallback();
            },
          },
        );
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message)) return;

      if (message.method === "agents.sessions.sendMessage") {
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, { runId: "run-1" })));
        return;
      }
      if (message.method === "config.get") {
        callbackInvocationIds.push(
          (message as { paperclipInvocationId?: string }).paperclipInvocationId ?? "",
        );
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {})));
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.session-scope-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Session scope test",
          description: "Session scope test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["agent.sessions.send"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });

      expect(sendSessionMessage).not.toBeNull();
      await sendSessionMessage!();
      hostToWorker.write(serializeMessage({
        ...createNotification("agents.sessions.event", {
          companyId: "company-a",
          sessionId: "session-1",
          runId: "run-1",
          seq: 1,
          eventType: "done",
          stream: "system",
          message: "Run completed",
          payload: null,
        }),
        paperclipInvocation: {
          id: "session-event-invocation",
          scope: { companyId: "company-a" },
        },
      }));

      await callbackComplete;
      expect(callbackInvocationIds).toEqual(["session-event-invocation"]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker secret resolution RPC", () => {
  it("serializes object refs and injects company scope only in the host", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedCalls: Array<{ method: string; params: unknown }> = [];
    let nextRequestId = 1;

    const secretRef: EnvSecretRefBinding = {
      type: "secret_ref",
      secretId: "11111111-1111-4111-8111-111111111111",
    };
    const configPatch = vi.fn(async () => ({
      credentials: { apiKey: secretRef },
    }));
    const secretsResolve = vi.fn(async () => "resolved-secret");
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.secret-rpc-test",
      capabilities: ["secrets.bind-ref", "secrets.read-ref"],
      services: {
        config: {
          get: vi.fn(async () => ({})),
          patchSecretRefs: configPatch,
        },
        secrets: {
          resolve: secretsResolve,
        },
      } as unknown as HostServices,
    });
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("resolve-secret", async (params) => {
          if (params.missingInput === true) {
            return ctx.config.patchSecretRefs(undefined as never);
          }
          if (params.missingPath === true) {
            return ctx.config.patchSecretRefs({ value: null } as never);
          }
          if (params.sparse === true) {
            const sparse = new Array<EnvSecretRefBinding>(2);
            sparse[1] = params.secretRef as EnvSecretRefBinding;
            return ctx.config.patchSecretRefs({
              path: ["credentials", "items"],
              value: sparse,
            });
          }
          if (params.invalidNumbers === true) {
            return ctx.config.patchSecretRefs({
              path: ["credentials", "items"],
              value: [undefined, Number.NaN, Number.POSITIVE_INFINITY] as never,
            });
          }
          if (params.prototypePatch !== undefined) {
            return ctx.config.patchSecretRefs({
              path: ["credentials"],
              value: params.prototypePatch as never,
            });
          }
          const config = await ctx.config.patchSecretRefs({
            path: ["credentials"],
            value: { apiKey: params.secretRef as EnvSecretRefBinding },
          });
          const secret = await ctx.secrets.resolve(params.secretRef as EnvSecretRefBinding, {
            configPath: String(params.configPath),
          });
          return { config, secret };
        });
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown, invocation?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (
        !isJsonRpcRequest(message)
        || (
          message.method !== "config.patchSecretRefs"
          && message.method !== "secrets.resolve"
        )
      ) {
        return;
      }

      nestedCalls.push({ method: message.method, params: message.params });
      const invocationId =
        (message as { paperclipInvocationId?: string }).paperclipInvocationId ?? "";
      const context = invocationId === "secret-invocation"
        ? { invocationScope: { companyId: "company-a" } }
        : { invalidInvocationScope: true };
      const hostCall = message.method === "config.patchSecretRefs"
        ? handlers["config.patchSecretRefs"](message.params as never, context)
        : handlers["secrets.resolve"](message.params as never, context);
      void hostCall
        .then((result) => {
          hostToWorker.write(serializeMessage(createSuccessResponse(message.id, result)));
        })
        .catch((error: unknown) => {
          hostToWorker.write(serializeMessage(createErrorResponse(
            message.id,
            PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
            error instanceof Error ? error.message : String(error),
          )));
        });
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.secret-rpc-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Secret RPC test",
          description: "Secret RPC test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["secrets.bind-ref", "secrets.read-ref"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });

      await expect(callWorker(
        "getData",
        {
          key: "resolve-secret",
          companyId: "company-a",
          params: {
            secretRef,
            configPath: "credentials.apiKey",
          },
        },
        { id: "secret-invocation", scope: { companyId: "company-a" } },
      )).resolves.toEqual({
        config: { credentials: { apiKey: secretRef } },
        secret: "resolved-secret",
      });

      expect(nestedCalls).toEqual([
        {
          method: "config.patchSecretRefs",
          params: {
            path: ["credentials"],
            value: { apiKey: secretRef },
          },
        },
        {
          method: "secrets.resolve",
          params: {
            secretRef,
            configPath: "credentials.apiKey",
          },
        },
      ]);
      expect(configPatch).toHaveBeenCalledWith({
        companyId: "company-a",
        path: ["credentials"],
        value: { apiKey: secretRef },
      }, {
        invocationScope: { companyId: "company-a" },
      });
      expect(secretsResolve).toHaveBeenCalledWith({
        companyId: "company-a",
        secretRef,
        configPath: "credentials.apiKey",
      }, {
        invocationScope: { companyId: "company-a" },
      });

      await expect(callWorker(
        "getData",
        {
          key: "resolve-secret",
          companyId: "company-a",
          params: {
            sparse: true,
            secretRef,
          },
        },
        { id: "secret-invocation", scope: { companyId: "company-a" } },
      )).rejects.toThrow(/sparse entries/i);
      expect(nestedCalls).toHaveLength(2);
      expect(configPatch).toHaveBeenCalledTimes(1);

      await expect(callWorker(
        "getData",
        {
          key: "resolve-secret",
          companyId: "company-a",
          params: {
            invalidNumbers: true,
          },
        },
        { id: "secret-invocation", scope: { companyId: "company-a" } },
      )).rejects.toThrow(/only secret_ref objects/i);
      expect(nestedCalls).toHaveLength(2);
      expect(configPatch).toHaveBeenCalledTimes(1);

      for (const params of [{ missingInput: true }, { missingPath: true }]) {
        await expect(callWorker(
          "getData",
          {
            key: "resolve-secret",
            companyId: "company-a",
            params,
          },
          { id: "secret-invocation", scope: { companyId: "company-a" } },
        )).rejects.toThrow(/requires an object with path and value fields/i);
      }
      expect(nestedCalls).toHaveLength(2);
      expect(configPatch).toHaveBeenCalledTimes(1);

      for (const key of ["__proto__", "constructor", "prototype"]) {
        const prototypePatch = JSON.parse(
          `{"${key}":{"type":"secret_ref","secretId":"${secretRef.secretId}"}}`,
        ) as Record<string, unknown>;
        await expect(callWorker(
          "getData",
          {
            key: "resolve-secret",
            companyId: "company-a",
            params: { prototypePatch },
          },
          { id: "secret-invocation", scope: { companyId: "company-a" } },
        )).rejects.toThrow(/safe object keys/i);
      }
      expect(nestedCalls).toHaveLength(2);
      expect(configPatch).toHaveBeenCalledTimes(1);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});
