import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import {
  DEFAULT_SANDBOX_REMOTE_CWD,
  resolveEnvironmentExecutionTarget,
} from "../services/environment-execution-target.js";

describe("resolveEnvironmentExecutionTarget", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
  });

  it("uses a bounded default cwd for sandbox targets when lease metadata omits remoteCwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
      leaseId: "lease-1",
      environmentId: "env-1",
      timeoutMs: 30_000,
    });
  });

  it("honors provider-defined workspace sync for sandbox-compatible plugin leases", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "paperclip.coder-sandbox-provider",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-coder-1",
        driver: "sandbox",
        config: {
          provider: "paperclip.coder-sandbox-provider",
        },
      },
      leaseId: "lease-coder-1",
      leaseMetadata: {
        workspaceRealization: { sync: { strategy: "provider_defined" } },
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      providerKey: "paperclip.coder-sandbox-provider",
      syncWorkspace: false,
    });
  });

  it("keeps sandbox targets on bridge mode even when lease metadata includes a Paperclip API URL", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        paperclipApiUrl: "https://paperclip.example.test",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
    });
    expect(target).not.toHaveProperty("paperclipApiUrl");
    expect(target).not.toHaveProperty("paperclipTransport");
  });

  it("passes through a provider-declared sandbox shell command from lease metadata", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "claude_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        shellCommand: "bash",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      shellCommand: "bash",
    });
  });

  it("keeps sandbox targets on callback bridge execution even when lease metadata advertises SSH access", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "claude_local",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        remoteCwd: "/home/sandbox/paperclip-workspace",
        sshAccess: {
          type: "ssh",
          host: "ssh.example.test",
          port: 22,
          username: "paperclip",
        },
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: "/home/sandbox/paperclip-workspace",
    });
  });

  it("resolves plugin environments as sandbox callback targets", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "plugin",
      config: {
        pluginKey: "paperclip.coder-sandbox-provider",
        driverKey: "coder",
        driverConfig: {
          timeoutMs: 840_000,
        },
      },
    });
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok",
      stderr: "",
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-coder-1",
        driver: "plugin",
        config: {},
      },
      leaseId: "lease-coder-1",
      leaseMetadata: {
        providerMetadata: { remoteCwd: "/home/coder/workspace", shellCommand: "bash" },
        workspaceRealization: { sync: { strategy: "provider_defined" } },
      },
      lease: {} as never,
      environmentRuntime: { execute } as never,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "paperclip.coder-sandbox-provider:coder",
      remoteCwd: "/home/coder/workspace",
      shellCommand: "bash",
      timeoutMs: 840_000,
      syncWorkspace: false,
      streamRunLogs: true,
    });

    const result = await (target as Extract<typeof target, { transport: "sandbox" }>).runner!.execute({
      command: "bash",
      args: ["-lc", "pwd"],
      cwd: "/home/coder/workspace",
      env: {},
      timeoutMs: 30_000,
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "bash",
      args: ["-lc", "pwd"],
      cwd: "/home/coder/workspace",
    }));
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok" });
  });

  it("keeps core workspace sync when a legacy plugin omits workspace realization", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "plugin",
      config: {
        pluginKey: "acme.legacy-sandbox-provider",
        driverKey: "legacy",
        driverConfig: {},
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-legacy-1", driver: "plugin", config: {} },
      leaseId: "lease-legacy-1",
      leaseMetadata: { remoteCwd: "/home/legacy/workspace" },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      remoteCwd: "/home/legacy/workspace",
    });
    expect(target).not.toHaveProperty("syncWorkspace");
  });

  it("falls back to the plugin driver cwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "plugin",
      config: {
        pluginKey: "paperclip.coder-sandbox-provider",
        driverKey: "coder",
        driverConfig: { remoteCwd: "/home/coder/from-config" },
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "plugin", config: {} },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({ remoteCwd: "/home/coder/from-config" });
  });

  it("rejects plugin targets without a remote cwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "plugin",
      config: {
        pluginKey: "paperclip.coder-sandbox-provider",
        driverKey: "coder",
        driverConfig: {},
      },
    });

    await expect(resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "plugin", config: {} },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    })).rejects.toThrow('Plugin environment "env-1" did not provide a remote workspace cwd.');
  });

  it("prefers a freshly realized remote cwd over stale realization metadata", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "plugin",
      config: {
        pluginKey: "paperclip.coder-sandbox-provider",
        driverKey: "coder",
        driverConfig: {},
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: { id: "env-1", driver: "plugin", config: {} },
      leaseId: "lease-1",
      leaseMetadata: {
        remoteCwd: "/home/coder/fresh",
        workspaceRealization: { remote: { path: "/home/coder/stale" } },
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({ remoteCwd: "/home/coder/fresh" });
  });

  it("resolves SSH execution targets in bridge mode", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        privateKey: "PRIVATE KEY",
        knownHosts: "[ssh.example.test]:22 ssh-ed25519 AAAA",
        strictHostKeyChecking: true,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex_local",
      environment: {
        id: "env-ssh-1",
        driver: "ssh",
        config: {},
      },
      leaseId: "lease-ssh-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip",
      leaseId: "lease-ssh-1",
      environmentId: "env-ssh-1",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        remoteCwd: "/srv/paperclip",
      },
    });
    expect(target).not.toHaveProperty("paperclipApiUrl");
  });
});
