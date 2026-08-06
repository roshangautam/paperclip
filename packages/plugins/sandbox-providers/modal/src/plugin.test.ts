import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  JsonRpcCallError,
  PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY,
  PLUGIN_RPC_ERROR_CODES,
} from "@paperclipai/plugin-sdk";

const { MockNotFoundError, MockTimeoutError, MockSandboxTimeoutError } = vi.hoisted(() => {
  class MockNotFoundError extends Error {}
  class MockTimeoutError extends Error {}
  class MockSandboxTimeoutError extends Error {}
  return { MockNotFoundError, MockTimeoutError, MockSandboxTimeoutError };
});

const mockAppFromName = vi.hoisted(() => vi.fn());
const mockImageBuild = vi.hoisted(() => vi.fn());
const mockImageFromRegistry = vi.hoisted(() =>
  vi.fn(() => ({ kind: "image", build: mockImageBuild })),
);
const mockSandboxesCreate = vi.hoisted(() => vi.fn());
const mockSandboxesFromId = vi.hoisted(() => vi.fn());
const mockSandboxesFromName = vi.hoisted(() => vi.fn());
const mockClientClose = vi.hoisted(() => vi.fn());

vi.mock("modal", () => ({
  ModalClient: class MockModalClient {
    apps = { fromName: mockAppFromName };
    images = { fromRegistry: mockImageFromRegistry };
    sandboxes = {
      create: mockSandboxesCreate,
      fromId: mockSandboxesFromId,
      fromName: mockSandboxesFromName,
    };
    close = mockClientClose;
    constructor(_params?: unknown) {}
  },
  NotFoundError: MockNotFoundError,
  TimeoutError: MockTimeoutError,
  SandboxTimeoutError: MockSandboxTimeoutError,
}));

import plugin from "./plugin.js";

interface FakeSandboxOverrides {
  id?: string;
  tags?: Record<string, string>;
  execImpl?: (argv: string[], params?: unknown) => Promise<FakeProcess>;
}

interface FakeProcess {
  stdout: { readText: () => Promise<string> };
  stderr: { readText: () => Promise<string> };
  wait: () => Promise<number>;
}

function makeFakeProcess(input: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  throwOnWait?: unknown;
}): FakeProcess {
  return {
    stdout: { readText: vi.fn().mockResolvedValue(input.stdout ?? "") },
    stderr: { readText: vi.fn().mockResolvedValue(input.stderr ?? "") },
    wait: vi.fn().mockImplementation(async () => {
      if (input.throwOnWait) throw input.throwOnWait;
      return input.exitCode ?? 0;
    }),
  };
}

function createFakeSandbox(overrides: FakeSandboxOverrides = {}) {
  const execCalls: Array<{ argv: string[]; params?: unknown }> = [];
  const defaultExec = async (_argv: string[], _params?: unknown): Promise<FakeProcess> =>
    makeFakeProcess({ exitCode: 0, stdout: "paperclip-probe" });
  const exec = vi.fn().mockImplementation(async (argv: string[], params?: unknown) => {
    execCalls.push({ argv, params });
    return overrides.execImpl ? overrides.execImpl(argv, params) : defaultExec(argv, params);
  });
  const openedFiles: Array<{ path: string; mode: string; written: Uint8Array | null }> = [];
  const sandbox = {
    sandboxId: overrides.id ?? "sb-123",
    exec,
    execCalls,
    openedFiles,
    setTags: vi.fn().mockResolvedValue(undefined),
    getTags: vi.fn().mockResolvedValue(overrides.tags ?? {
      "paperclip-acquisition-id": "acquisition-1",
    }),
    terminate: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn(),
    poll: vi.fn().mockResolvedValue(null),
    open: vi.fn().mockImplementation(async (path: string, mode: string) => {
      const entry: { path: string; mode: string; written: Uint8Array | null } = {
        path,
        mode,
        written: null,
      };
      openedFiles.push(entry);
      return {
        write: vi.fn().mockImplementation(async (data: Uint8Array) => {
          entry.written = data;
        }),
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
  return sandbox;
}

type FakeSandbox = ReturnType<typeof createFakeSandbox>;

const baseAcquireParams = {
  driverKey: "modal",
  companyId: "company-1",
  environmentId: "env-1",
  acquisitionId: "acquisition-1",
  runId: "run-1",
};

const baseConfig = {
  appName: "paperclip-app",
  image: "node:20",
  sandboxTimeoutMs: 3_600_000,
  execTimeoutMs: 300_000,
  reuseLease: false,
};

const baseConfigWithTokens = {
  ...baseConfig,
  tokenId: "config-id",
  tokenSecret: "config-secret",
};

function acquisitionSandboxName(acquisitionId: string): string {
  return `pc-acq-${createHash("sha256").update(acquisitionId).digest("hex").slice(0, 32)}`;
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockAppFromName.mockReset();
  mockImageBuild.mockReset();
  mockImageBuild.mockResolvedValue(undefined);
  mockImageFromRegistry.mockReset();
  mockImageFromRegistry.mockReturnValue({ kind: "image", build: mockImageBuild });
  mockSandboxesCreate.mockReset();
  mockSandboxesFromId.mockReset();
  mockSandboxesFromName.mockReset();
  mockSandboxesFromName.mockRejectedValue(new MockNotFoundError("not found"));
  mockClientClose.mockReset();
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
});

describe("Modal sandbox provider plugin", () => {
  it("declares environment lifecycle handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: "Modal sandbox provider plugin healthy",
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentReleaseLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
  });

  it("normalizes config when both tokens are provided", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "modal",
      config: {
        appName: "  app-1  ",
        image: " node:20 ",
        tokenId: " token-id ",
        tokenSecret: " token-secret ",
        environment: " main ",
        workdir: " /srv/work ",
        sandboxTimeoutMs: "1800000",
        idleTimeoutMs: "60000",
        execTimeoutMs: "120000",
        reuseLease: true,
        blockNetwork: false,
        cidrAllowlist: ["10.0.0.0/8"],
      },
    });

    expect(result).toEqual({
      ok: true,
      normalizedConfig: {
        appName: "app-1",
        image: "node:20",
        tokenId: "token-id",
        tokenSecret: "token-secret",
        environment: "main",
        workdir: "/srv/work",
        sandboxTimeoutMs: 1_800_000,
        idleTimeoutMs: 60_000,
        execTimeoutMs: 120_000,
        blockNetwork: false,
        cidrAllowlist: ["10.0.0.0/8"],
        reuseLease: true,
      },
    });
  });

  it("ignores host MODAL_TOKEN_* env vars (plugin worker does not inherit them)", async () => {
    process.env.MODAL_TOKEN_ID = "host-id";
    process.env.MODAL_TOKEN_SECRET = "host-secret";

    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "modal",
      config: { ...baseConfig },
    });

    expect(result).toEqual({
      ok: false,
      errors: ["Modal sandbox environments require tokenId and tokenSecret."],
    });
  });

  it("rejects invalid config", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "modal",
      config: {
        appName: "",
        image: "",
        workdir: "relative/workdir",
        sandboxTimeoutMs: 1500,
        idleTimeoutMs: 1500,
        execTimeoutMs: 0,
        blockNetwork: true,
        cidrAllowlist: ["1.2.3.4/32"],
        tokenId: "only-id",
      },
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        "Modal sandbox environments require an appName.",
        "Modal sandbox environments require an image reference.",
        "workdir must be an absolute path, got: relative/workdir",
        "sandboxTimeoutMs must be a positive multiple of 1000 between 1000 and 86400000.",
        "idleTimeoutMs must be a positive multiple of 1000 when provided.",
        "execTimeoutMs must be a positive multiple of 1000.",
        "cidrAllowlist cannot be combined with blockNetwork.",
        "tokenId and tokenSecret must both be provided when either is set.",
      ],
    });
  });

  it("requires both tokens in config", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig?.({
      driverKey: "modal",
      config: { ...baseConfig },
    });
    expect(result).toEqual({
      ok: false,
      errors: ["Modal sandbox environments require tokenId and tokenSecret."],
    });
  });

  it("probes by creating, executing, and terminating a sandbox", async () => {
    const sandbox = createFakeSandbox();
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesCreate.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: { ...baseConfig, workdir: "/srv/work" },
    });

    expect(mockAppFromName).toHaveBeenCalledWith("paperclip-app", {
      createIfMissing: true,
      environment: undefined,
    });
    expect(mockImageFromRegistry).toHaveBeenCalledWith("node:20");
    expect(mockSandboxesCreate).toHaveBeenCalledWith(
      { appId: "ap-1" },
      expect.objectContaining({ kind: "image" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          "paperclip-provider": "modal",
          "paperclip-company-id": "c-1",
        }),
      }),
    );
    // First exec is the mkdir for the workspace, second is the probe command.
    expect(sandbox.execCalls[0]?.argv).toEqual([
      "sh",
      "-lc",
      "mkdir -p '/srv/work'",
    ]);
    expect(sandbox.execCalls[1]?.argv).toEqual([
      "sh",
      "-lc",
      "printf paperclip-probe",
    ]);
    expect(sandbox.terminate).toHaveBeenCalled();
    expect(mockClientClose).toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      metadata: {
        provider: "modal",
        sandboxId: "sb-123",
        remoteCwd: "/srv/work",
        reuseLease: false,
      },
    });
  });

  it("returns a failure probe result when the probe command exits non-zero", async () => {
    const sandbox = createFakeSandbox({
      execImpl: async (argv: string[]) => {
        if (argv[2] === "printf paperclip-probe") {
          return makeFakeProcess({ exitCode: 7, stdout: "boom" });
        }
        return makeFakeProcess({ exitCode: 0 });
      },
    });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesCreate.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: baseConfig,
    });

    expect(result?.ok).toBe(false);
    expect(sandbox.terminate).toHaveBeenCalled();
  });

  it("closes the Modal client when probe fails before sandbox creation", async () => {
    mockAppFromName.mockRejectedValue(new Error("app lookup failed"));

    const result = await plugin.definition.onEnvironmentProbe?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: baseConfig,
    });

    expect(result).toMatchObject({
      ok: false,
      summary: "Modal sandbox probe failed.",
      metadata: expect.objectContaining({
        error: "app lookup failed",
      }),
    });
    expect(mockClientClose).toHaveBeenCalledTimes(1);
  });

  it("acquires a lease, applies tags, and ensures the workspace directory", async () => {
    const sandbox = createFakeSandbox({ id: "sb-acquire" });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesCreate.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: { ...baseConfig, reuseLease: true, workdir: "/srv/work" },
    });

    expect(lease).toEqual({
      providerLeaseId: "sb-acquire",
      metadata: expect.objectContaining({
        provider: "modal",
        sandboxId: "sb-acquire",
        remoteCwd: "/srv/work",
        reuseLease: true,
        resumedLease: false,
      }),
    });
    expect(mockSandboxesFromName).toHaveBeenCalledWith(
      "paperclip-app",
      expect.stringMatching(/^pc-acq-[a-f0-9]{32}$/),
      { environment: undefined },
    );
    expect(mockSandboxesCreate).toHaveBeenCalledWith(
      { appId: "ap-1" },
      expect.objectContaining({ kind: "image" }),
      expect.objectContaining({
        name: expect.stringMatching(/^pc-acq-[a-f0-9]{32}$/),
        tags: expect.objectContaining({
          "paperclip-acquisition-id": "acquisition-1",
          "paperclip-run-id": "run-1",
          "paperclip-reuse-lease": "true",
        }),
      }),
    );
    expect(sandbox.execCalls[0]?.argv).toEqual(["sh", "-lc", "mkdir -p '/srv/work'"]);
  });

  it("replays an acquisition by exact name without creating a second sandbox", async () => {
    const sandbox = createFakeSandbox({ id: "sb-existing" });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesFromName.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    });

    expect(lease).toMatchObject({
      providerLeaseId: "sb-existing",
      metadata: {
        acquisitionId: "acquisition-1",
        resumedLease: false,
      },
    });
    expect(mockSandboxesCreate).not.toHaveBeenCalled();
    expect(sandbox.setTags).not.toHaveBeenCalled();
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it("rejects an untagged sandbox after an ambiguous create error", async () => {
    const sandbox = createFakeSandbox({ id: "sb-reconciled", tags: {} });
    let rejectCreate!: (error: Error) => void;
    const pendingCreate = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject;
    });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesCreate.mockReturnValue(pendingCreate);

    const acquisition = plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    });
    await vi.waitFor(() => expect(mockSandboxesCreate).toHaveBeenCalledTimes(1));
    mockSandboxesFromName.mockResolvedValue(sandbox);
    rejectCreate(new Error("create response lost"));

    await expect(acquisition).rejects.toThrow("Refusing to adopt unowned Modal sandbox");
    expect(mockSandboxesCreate).toHaveBeenCalledTimes(1);
    expect(mockSandboxesFromName).toHaveBeenCalledTimes(2);
    expect(sandbox.setTags).not.toHaveBeenCalled();
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it("hands off a deterministic cleanup lease when an ambiguous create remains invisible", async () => {
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesCreate.mockRejectedValue(new Error("create response lost"));

    const error = await plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JsonRpcCallError);
    expect(error).toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "create response lost",
      data: {
        providerLeaseId: expect.stringMatching(/^pc-acq-[a-f0-9]{32}$/),
      },
    });
    expect(mockSandboxesCreate).toHaveBeenCalledTimes(1);
    expect(mockSandboxesFromName).toHaveBeenCalledTimes(2);
  });

  it("rejects image build failures before entering the ambiguous create boundary", async () => {
    const buildError = new Error("image build failed");
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockImageBuild.mockRejectedValue(buildError);

    const error = await plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    }).catch((caught: unknown) => caught);

    expect(error).toBe(buildError);
    expect(error).not.toBeInstanceOf(JsonRpcCallError);
    expect(mockImageBuild).toHaveBeenCalledWith({ appId: "ap-1" });
    expect(mockSandboxesCreate).not.toHaveBeenCalled();
    expect(mockSandboxesFromName).toHaveBeenCalledTimes(1);
  });

  it("preserves the deterministic cleanup lease when reconciliation lookup fails", async () => {
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesFromName
      .mockRejectedValueOnce(new MockNotFoundError("not found"))
      .mockRejectedValueOnce(new Error("reconciliation lookup failed"));
    mockSandboxesCreate.mockRejectedValue(new Error("create response lost"));

    const error = await plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "create response lost",
      data: {
        providerLeaseId: acquisitionSandboxName("acquisition-1"),
      },
    });
    expect(mockSandboxesCreate).toHaveBeenCalledTimes(1);
    expect(mockSandboxesFromName).toHaveBeenCalledTimes(2);
  });

  it("preserves the deterministic cleanup lease when reconciliation tag lookup fails", async () => {
    const sandbox = createFakeSandbox({ id: "sb-reconciled" });
    sandbox.getTags.mockRejectedValue(new Error("tag lookup failed"));
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesFromName
      .mockRejectedValueOnce(new MockNotFoundError("not found"))
      .mockResolvedValueOnce(sandbox);
    mockSandboxesCreate.mockRejectedValue(new Error("create response lost"));

    const error = await plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "create response lost",
      data: {
        providerLeaseId: acquisitionSandboxName("acquisition-1"),
      },
    });
    expect(sandbox.getTags).toHaveBeenCalledTimes(1);
  });

  it("reconciles a successful ambiguous create by its verified deterministic name", async () => {
    const sandbox = createFakeSandbox({ id: "sb-reconciled" });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesFromName
      .mockRejectedValueOnce(new MockNotFoundError("not found"))
      .mockResolvedValueOnce(sandbox);
    mockSandboxesCreate.mockRejectedValue(new Error("create response lost"));

    const lease = await plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    });

    expect(lease).toMatchObject({
      providerLeaseId: "sb-reconciled",
      metadata: {
        acquisitionId: "acquisition-1",
        resumedLease: false,
      },
    });
    expect(mockSandboxesCreate).toHaveBeenCalledTimes(1);
    expect(mockSandboxesFromName).toHaveBeenCalledTimes(2);
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it("rejects a wrong-owner sandbox after an ambiguous create error", async () => {
    const sandbox = createFakeSandbox({
      id: "sb-conflict",
      tags: { "paperclip-acquisition-id": "different-acquisition" },
    });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesFromName
      .mockRejectedValueOnce(new MockNotFoundError("not found"))
      .mockResolvedValueOnce(sandbox);
    mockSandboxesCreate.mockRejectedValue(new Error("create response lost"));

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    })).rejects.toThrow("acquisition ownership does not match acquisition-1");
    expect(mockSandboxesCreate).toHaveBeenCalledTimes(1);
    expect(mockSandboxesFromName).toHaveBeenCalledTimes(2);
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it("rejects a deterministic-name sandbox owned by another acquisition", async () => {
    const sandbox = createFakeSandbox({
      id: "sb-conflict",
      tags: { "paperclip-acquisition-id": "different-acquisition" },
    });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesFromName.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    })).rejects.toThrow("acquisition ownership does not match acquisition-1");
    expect(mockSandboxesCreate).not.toHaveBeenCalled();
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it("rejects an unowned deterministic-name sandbox before creating", async () => {
    const sandbox = createFakeSandbox({ id: "sb-unowned", tags: {} });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesFromName.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    })).rejects.toThrow("Refusing to adopt unowned Modal sandbox");
    expect(mockSandboxesCreate).not.toHaveBeenCalled();
    expect(sandbox.setTags).not.toHaveBeenCalled();
  });

  it("does not terminate an adopted sandbox when workspace setup fails", async () => {
    const sandbox = createFakeSandbox({
      id: "sb-adopted",
      execImpl: async () => makeFakeProcess({ throwOnWait: new Error("mkdir failed") }),
    });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesFromName.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    })).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "mkdir failed",
      data: {
        providerLeaseId: "sb-adopted",
        cleanupVerifiedAcquisitionId: "acquisition-1",
      },
    });
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it("hands off a created sandbox when acquire cleanup also fails", async () => {
    const sandbox = createFakeSandbox({
      id: "sb-terminate-failed",
      execImpl: async () => makeFakeProcess({ throwOnWait: new Error("mkdir failed") }),
    });
    sandbox.terminate.mockRejectedValue(new Error("terminate failed"));
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesCreate.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    })).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "mkdir failed",
      data: {
        providerLeaseId: "sb-terminate-failed",
        cleanupVerifiedAcquisitionId: "acquisition-1",
      },
    });
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates the sandbox if acquire workspace setup throws", async () => {
    const setupError = new Error("mkdir failed");
    const sandbox = createFakeSandbox({
      execImpl: async (argv: string[]) => {
        if (argv[2]?.startsWith("mkdir -p")) {
          return makeFakeProcess({ throwOnWait: setupError });
        }
        return makeFakeProcess({ exitCode: 0 });
      },
    });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesCreate.mockResolvedValue(sandbox);

    const error = await plugin.definition.onEnvironmentAcquireLease?.({
      ...baseAcquireParams,
      config: baseConfig,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JsonRpcCallError);
    expect(error).toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "mkdir failed",
      data: {
        providerLeaseId: sandbox.sandboxId,
        cleanupVerifiedAcquisitionId: "acquisition-1",
      },
    });
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("fails acquire when workspace creation exits non-zero", async () => {
    const sandbox = createFakeSandbox({
      execImpl: async (argv: string[]) => {
        if (argv[2]?.startsWith("mkdir -p")) {
          return makeFakeProcess({ exitCode: 17 });
        }
        return makeFakeProcess({ exitCode: 0 });
      },
    });
    mockAppFromName.mockResolvedValue({ appId: "ap-1" });
    mockSandboxesCreate.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentAcquireLease?.({
        ...baseAcquireParams,
        config: baseConfig,
      }),
    ).rejects.toThrow(
      "Failed to create remote workspace directory '/workspace/paperclip': mkdir exited with code 17",
    );
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("closes the Modal client when acquire fails before sandbox creation", async () => {
    mockAppFromName.mockRejectedValue(new Error("app lookup failed"));

    await expect(
      plugin.definition.onEnvironmentAcquireLease?.({
        ...baseAcquireParams,
        config: baseConfig,
      }),
    ).rejects.toThrow("app lookup failed");
    expect(mockClientClose).toHaveBeenCalledTimes(1);
  });

  it("rejects a relative acquire workdir before any Modal activity", async () => {
    await expect(
      plugin.definition.onEnvironmentAcquireLease?.({
        ...baseAcquireParams,
        config: { ...baseConfig, workdir: "relative/workdir" },
      }),
    ).rejects.toThrow("workdir must be an absolute path, got: relative/workdir");

    expect(mockAppFromName).not.toHaveBeenCalled();
    expect(mockSandboxesFromName).not.toHaveBeenCalled();
    expect(mockSandboxesCreate).not.toHaveBeenCalled();
    expect(mockImageFromRegistry).not.toHaveBeenCalled();
    expect(mockClientClose).not.toHaveBeenCalled();
  });

  it("treats missing leases as expired on resume", async () => {
    mockSandboxesFromId.mockRejectedValue(new MockNotFoundError("gone"));

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      providerLeaseId: "sb-missing",
      config: { ...baseConfig, reuseLease: true },
    });
    expect(lease).toEqual({ providerLeaseId: null, metadata: { expired: true } });
  });

  it("resumes a reusable lease by reconnecting via fromId", async () => {
    const sandbox = createFakeSandbox({ id: "sb-resume" });
    mockSandboxesFromId.mockResolvedValue(sandbox);

    const lease = await plugin.definition.onEnvironmentResumeLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      providerLeaseId: "sb-resume",
      config: { ...baseConfig, reuseLease: true },
    });

    expect(lease).toEqual({
      providerLeaseId: "sb-resume",
      metadata: expect.objectContaining({
        provider: "modal",
        sandboxId: "sb-resume",
        resumedLease: true,
        reuseLease: true,
      }),
    });
  });

  it("detaches the sandbox if resumed workspace setup fails", async () => {
    const sandbox = createFakeSandbox({
      id: "sb-resume",
      execImpl: async (argv: string[]) => {
        if (argv[2]?.startsWith("mkdir -p")) {
          return makeFakeProcess({ throwOnWait: new Error("mkdir failed") });
        }
        return makeFakeProcess({ exitCode: 0 });
      },
    });
    mockSandboxesFromId.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentResumeLease?.({
        driverKey: "modal",
        companyId: "c-1",
        environmentId: "e-1",
        providerLeaseId: "sb-resume",
        config: { ...baseConfig, reuseLease: true },
      }),
    ).rejects.toThrow("mkdir failed");
    expect(sandbox.detach).toHaveBeenCalledTimes(1);
  });

  it("detaches reusable leases and terminates ephemeral leases on release", async () => {
    const reusable = createFakeSandbox({ id: "sb-reuse" });
    const ephemeral = createFakeSandbox({ id: "sb-ephem" });
    mockSandboxesFromId.mockResolvedValueOnce(reusable).mockResolvedValueOnce(ephemeral);

    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      providerLeaseId: "sb-reuse",
      config: { ...baseConfig, reuseLease: true },
    });
    await plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      providerLeaseId: "sb-ephem",
      config: { ...baseConfig, reuseLease: false },
    });

    expect(reusable.detach).toHaveBeenCalled();
    expect(reusable.terminate).not.toHaveBeenCalled();
    expect(ephemeral.terminate).toHaveBeenCalled();
    expect(ephemeral.detach).not.toHaveBeenCalled();
  });

  it.each([
    ["release", plugin.definition.onEnvironmentReleaseLease],
    ["destroy", plugin.definition.onEnvironmentDestroyLease],
  ])("reconciles and terminates a deterministic cleanup lease on %s", async (_operation, handler) => {
    const sandbox = createFakeSandbox({ id: "sb-reconciled" });
    const providerLeaseId = acquisitionSandboxName("acquisition-1");
    mockSandboxesFromName.mockResolvedValue(sandbox);

    await handler?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      acquisitionId: "acquisition-1",
      providerLeaseId,
      config: baseConfig,
    });

    expect(mockSandboxesFromName).toHaveBeenCalledWith(
      "paperclip-app",
      providerLeaseId,
      { environment: undefined },
    );
    expect(mockSandboxesFromId).not.toHaveBeenCalled();
    expect(sandbox.terminate).toHaveBeenCalledTimes(1);
  });

  it("requires deterministic cleanup to be retried while the sandbox is not visible", async () => {
    const providerLeaseId = acquisitionSandboxName("acquisition-1");

    await expect(plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      acquisitionId: "acquisition-1",
      providerLeaseId,
      config: baseConfig,
    })).rejects.toThrow(
      `Modal sandbox ${providerLeaseId} is not visible yet; cleanup must be retried.`,
    );
    expect(mockSandboxesFromName).toHaveBeenCalledTimes(1);
    expect(mockSandboxesFromId).not.toHaveBeenCalled();
  });

  it("accepts an absent deterministic cleanup lease after verified cleanup", async () => {
    const providerLeaseId = acquisitionSandboxName("acquisition-1");

    await expect(plugin.definition.onEnvironmentReleaseLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      acquisitionId: "acquisition-1",
      providerLeaseId,
      leaseMetadata: {
        [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: "acquisition-1",
      },
      config: baseConfig,
    })).resolves.toBeUndefined();
    expect(mockSandboxesFromName).toHaveBeenCalledTimes(1);
    expect(mockSandboxesFromId).not.toHaveBeenCalled();
  });

  it("returns a verified cleanup lease when deterministic termination fails", async () => {
    const sandbox = createFakeSandbox({ id: "sb-reconciled" });
    sandbox.terminate.mockRejectedValue(new Error("terminate failed"));
    const providerLeaseId = acquisitionSandboxName("acquisition-1");
    mockSandboxesFromName.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentDestroyLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      acquisitionId: "acquisition-1",
      providerLeaseId,
      config: baseConfig,
    })).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "terminate failed",
      data: {
        providerLeaseId,
        cleanupVerifiedAcquisitionId: "acquisition-1",
      },
    });
  });

  it("refuses cleanup by provider ID when acquisition ownership does not match", async () => {
    const sandbox = createFakeSandbox({
      id: "sb-wrong-owner",
      tags: { "paperclip-acquisition-id": "different-acquisition" },
    });
    mockSandboxesFromId.mockResolvedValue(sandbox);

    await expect(plugin.definition.onEnvironmentDestroyLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      acquisitionId: "acquisition-1",
      providerLeaseId: "sb-wrong-owner",
      config: baseConfig,
    })).rejects.toThrow(
      "Refusing to adopt Modal sandbox sb-wrong-owner: acquisition ownership does not match acquisition-1.",
    );
    expect(sandbox.terminate).not.toHaveBeenCalled();
  });

  it("destroys leases by terminating, ignoring missing sandboxes", async () => {
    const sandbox = createFakeSandbox({ id: "sb-destroy" });
    mockSandboxesFromId.mockResolvedValueOnce(sandbox);

    await plugin.definition.onEnvironmentDestroyLease?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      providerLeaseId: "sb-destroy",
      config: baseConfig,
    });
    expect(sandbox.terminate).toHaveBeenCalled();

    mockSandboxesFromId.mockRejectedValueOnce(new MockNotFoundError("missing"));
    await expect(
      plugin.definition.onEnvironmentDestroyLease?.({
        driverKey: "modal",
        companyId: "c-1",
        environmentId: "e-1",
        providerLeaseId: "sb-missing",
        config: baseConfig,
      }),
    ).resolves.toBeUndefined();
  });

  it("realizes the workspace using the lease metadata cwd when available", async () => {
    const sandbox = createFakeSandbox({ id: "sb-real" });
    mockSandboxesFromId.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentRealizeWorkspace?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: baseConfig,
      lease: {
        providerLeaseId: "sb-real",
        metadata: { remoteCwd: "/srv/from-metadata" },
      },
      workspace: { localPath: "/local", remotePath: "/remote" },
    });

    expect(sandbox.execCalls[0]?.argv).toEqual([
      "sh",
      "-lc",
      "mkdir -p '/srv/from-metadata'",
    ]);
    expect(result).toEqual({
      cwd: "/srv/from-metadata",
      metadata: { provider: "modal", remoteCwd: "/srv/from-metadata" },
    });
  });

  it("executes commands with a login-shell wrapper that injects env after profile sourcing", async () => {
    const sandbox = createFakeSandbox({
      execImpl: async (argv: string[]) =>
        makeFakeProcess({
          exitCode: 5,
          stdout: "stdout-output",
          stderr: "stderr-output",
        }),
    });
    mockSandboxesFromId.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: baseConfig,
      lease: { providerLeaseId: "sb-exec", metadata: {} },
      command: "printf",
      args: ["hello"],
      cwd: "/srv/work",
      env: { FOO: "bar" },
      timeoutMs: 12_000,
    });

    expect(sandbox.execCalls).toHaveLength(1);
    const call = sandbox.execCalls[0]!;
    expect(call.argv[0]).toBe("sh");
    expect(call.argv[1]).toBe("-lc");
    const script = call.argv[2]!;
    expect(script).toMatch(/\/etc\/profile/);
    expect(script).toMatch(/cd '\/srv\/work'/);
    expect(script).toMatch(/&& exec env FOO='bar' 'printf' 'hello'$/);
    expect(call.params).toMatchObject({
      timeoutMs: 12_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result).toEqual({
      exitCode: 5,
      timedOut: false,
      stdout: "stdout-output",
      stderr: "stderr-output",
    });
  });

  it("stages stdin in the sandbox filesystem when execution needs redirected input", async () => {
    const sandbox = createFakeSandbox();
    mockSandboxesFromId.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: baseConfig,
      lease: { providerLeaseId: "sb-exec", metadata: {} },
      command: "cat",
      args: [],
      stdin: "input payload",
      cwd: "/srv/work",
    });

    expect(sandbox.openedFiles).toHaveLength(1);
    expect(sandbox.openedFiles[0]?.path).toMatch(/^\/tmp\/paperclip-stdin-/);
    expect(sandbox.openedFiles[0]?.mode).toBe("w");
    expect(sandbox.openedFiles[0]?.written).not.toBeNull();
    expect(new TextDecoder().decode(sandbox.openedFiles[0]!.written!)).toBe("input payload");

    // First exec is the user command; second is the rm cleanup.
    const userCall = sandbox.execCalls[0]!;
    expect(userCall.argv[2]).toMatch(/&& exec 'cat' < '\/tmp\/paperclip-stdin-/);
    const cleanupCall = sandbox.execCalls[1]!;
    expect(cleanupCall.argv[2]).toMatch(/^rm -f '\/tmp\/paperclip-stdin-/);
    expect(result?.exitCode).toBe(0);
  });

  it("rejects invalid shell env keys before execution", async () => {
    const sandbox = createFakeSandbox();
    mockSandboxesFromId.mockResolvedValue(sandbox);

    await expect(
      plugin.definition.onEnvironmentExecute?.({
        driverKey: "modal",
        companyId: "c-1",
        environmentId: "e-1",
        config: baseConfig,
        lease: { providerLeaseId: "sb-exec", metadata: {} },
        command: "printf",
        args: ["hello"],
        env: { "BAD-KEY": "v" },
      }),
    ).rejects.toThrow("Invalid sandbox environment variable key: BAD-KEY");
    expect(sandbox.execCalls).toHaveLength(0);
  });

  it("returns an error result when execute is called for an expired sandbox lease", async () => {
    mockSandboxesFromId.mockRejectedValue(new MockNotFoundError("gone"));

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: baseConfig,
      lease: { providerLeaseId: "sb-expired", metadata: {} },
      command: "printf",
      args: ["hello"],
    });

    expect(result).toEqual({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "Modal sandbox lease is no longer available.\n",
    });
  });

  it("returns a timedOut result when Modal raises a TimeoutError during exec", async () => {
    const sandbox = createFakeSandbox({
      execImpl: async () =>
        makeFakeProcess({ throwOnWait: new MockTimeoutError("exec timed out") }),
    });
    mockSandboxesFromId.mockResolvedValue(sandbox);

    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: baseConfig,
      lease: { providerLeaseId: "sb-exec", metadata: {} },
      command: "sleep",
      args: ["60"],
      cwd: "/srv/work",
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      exitCode: null,
      timedOut: true,
      stdout: "",
      stderr: "exec timed out\n",
    });
  });

  it("returns an error result when execute is called without a provider lease id", async () => {
    const result = await plugin.definition.onEnvironmentExecute?.({
      driverKey: "modal",
      companyId: "c-1",
      environmentId: "e-1",
      config: baseConfig,
      lease: { providerLeaseId: null, metadata: {} },
      command: "printf",
      args: ["hello"],
    });
    expect(result).toEqual({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "No provider lease ID available for execution.",
    });
  });
});
