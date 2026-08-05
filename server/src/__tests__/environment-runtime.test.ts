import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "@paperclipai/adapter-utils/ssh";
import {
  agents,
  activityLog,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  plugins,
  projects,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { environmentRuntimeService, findReusableSandboxLeaseId } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { secretService } from "../services/secrets.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import { logger } from "../middleware/logger.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sshFixtureSupport = await getSshEnvLabSupport();

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment runtime tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reusableRuntimeFingerprint(input: {
  provider: string;
  adapterType: string | null;
  config: Record<string, unknown>;
}) {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

describe("findReusableSandboxLeaseId", () => {
  it("matches reusable plugin-backed sandbox leases by provider", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake-plugin",
        image: "template-b",
        timeoutMs: 300000,
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-template-a",
          metadata: {
            provider: "fake-plugin",
            image: "template-a",
            timeoutMs: 300000,
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-template-b",
          metadata: {
            provider: "fake-plugin",
            image: "template-b",
            timeoutMs: 300000,
            reuseLease: true,
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-template-b");
  });

  it("requires image identity for reusable fake sandbox leases", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-image-a",
          metadata: {
            provider: "fake",
            image: "debian:12",
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-image-b",
          metadata: {
            provider: "fake",
            image: "ubuntu:24.04",
            reuseLease: true,
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-image-b");
  });
});

describeEmbeddedPostgres("environmentRuntimeService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let runtime!: ReturnType<typeof environmentRuntimeService>;
  const fixtureRoots: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("environment-runtime");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    runtime = environmentRuntimeService(db);
  });

  afterEach(async () => {
    while (fixtureRoots.length > 0) {
      const root = fixtureRoots.pop();
      if (!root) continue;
      await stopSshEnvLabFixture(path.join(root, "state.json")).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedEnvironment(input: {
    driver?: string;
    name?: string;
    status?: "active" | "disabled";
    config?: Record<string, unknown>;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    const driver = input.driver ?? "local";
    const environmentName = input.name ?? `${driver}-${environmentId.slice(0, 8)}`;
    let config = input.config ?? {};

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (typeof config.privateKey === "string" && config.privateKey.length > 0) {
      const secret = await secretService(db).create(companyId, {
        name: `environment-runtime-private-key-${randomUUID()}`,
        provider: "local_encrypted",
        value: config.privateKey,
      });
      await secretService(db).createBinding({
        companyId,
        secretId: secret.id,
        targetType: "environment",
        targetId: environmentId,
        configPath: "privateKeySecretRef",
      });
      config = {
        ...config,
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        },
      };
    }
    const existingLocalEnvironment = driver === "local"
      ? await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "local"))
        .then((rows) => rows[0] ?? null)
      : null;
    const environmentRecord = existingLocalEnvironment ?? {
      id: environmentId,
      name: environmentName,
      description: null,
      driver,
      status: input.status ?? "active",
      config,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (!existingLocalEnvironment) {
      await db.insert(environments).values({
        id: environmentRecord.id,
        name: environmentRecord.name,
        driver: environmentRecord.driver,
        status: environmentRecord.status,
        config: environmentRecord.config,
        createdAt: environmentRecord.createdAt,
        updatedAt: environmentRecord.updatedAt,
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      companyId,
      agentId,
      environment: {
        id: environmentRecord.id,
        companyId,
        name: environmentRecord.name,
        description: environmentRecord.description,
        driver: environmentRecord.driver,
        status: environmentRecord.status,
        config: environmentRecord.config,
        metadata: environmentRecord.metadata,
        createdAt: environmentRecord.createdAt,
        updatedAt: environmentRecord.updatedAt,
      } as const,
      runId,
    };
  }

  async function seedReusablePluginSandboxLease() {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.reusable-sandbox-provider",
      packageName: "@acme/reusable-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.reusable-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Reusable Sandbox Provider",
        description: "Test provider with reusable lease support",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                image: { type: "string" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const reusableLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "reusable-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.reusable-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    return { pluginId, companyId, agentId, environment, runId, executionWorkspaceId, reusableLease };
  }

  async function seedPluginSandboxLease(providerLeaseId: string) {
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Retrying Plugin Sandbox",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        reuseLease: false,
      },
    });
    const lease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      issueId: null,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
      provider: "fake-plugin",
      providerLeaseId,
      metadata: {
        driver: "sandbox",
        provider: "fake-plugin",
        pluginId,
        sandboxProviderPlugin: true,
        image: "fake:test",
        reuseLease: false,
      },
    });
    return { pluginId, lease, runId };
  }

  async function seedPendingPluginSandboxCleanup(providerLeaseId: string) {
    const seeded = await seedPluginSandboxLease(providerLeaseId);
    const failedRelease = environmentRuntimeService(db, {
      pluginWorkerManager: {
        isRunning: vi.fn(() => true),
        call: vi.fn(async () => {
          throw new Error("context canceled");
        }),
      } as unknown as PluginWorkerManager,
    });
    const pending = await failedRelease.releaseRunLeases(seeded.runId, "failed");
    await db
      .update(environmentLeases)
      .set({ updatedAt: new Date(0) })
      .where(eq(environmentLeases.id, seeded.lease.id));

    return { ...seeded, pending };
  }

  it("acquires and releases a local run lease through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment();

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.metadata).toMatchObject({
      driver: "local",
      executionWorkspaceMode: null,
    });
    expect(acquired.leaseContext).toEqual({
      executionWorkspaceId: null,
      executionWorkspaceMode: null,
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.environment.driver).toBe("local");
    expect(released[0]?.lease.status).toBe("released");

    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, acquired.lease.id));
    expect(rows[0]?.status).toBe("released");
  });

  it("allows projectless runs through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment();

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.executionWorkspaceId).toBeNull();
    expect(acquired.leaseContext.executionWorkspaceId).toBeNull();
    expect(acquired.leaseContext.executionWorkspaceMode).toBeNull();
  });

  it("rejects truly unsupported drivers before acquiring a lease", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment({
      driver: "ssh",
      name: "Fixture SSH",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    });
    const runtimeWithoutSsh = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async () => {
            throw new Error("should not acquire");
          },
          releaseRunLease: async () => null,
        },
      ],
    });

    await expect(
      runtimeWithoutSsh.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      }),
    ).rejects.toThrow('Environment driver "ssh" is not registered in the environment runtime yet.');

    const rows = await db.select().from(environmentLeases);
    expect(rows).toHaveLength(0);
  });

  it("acquires and releases an SSH run lease through the runtime seam", async () => {
    if (!sshFixtureSupport.supported) {
      console.warn(
        `Skipping SSH runtime fixture test: ${sshFixtureSupport.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-environment-runtime-ssh-"));
    fixtureRoots.push(fixtureRoot);
    const statePath = path.join(fixtureRoot, "state.json");
    const fixture = await startSshEnvLabFixture({ statePath });
    const sshConfig = await buildSshEnvLabFixtureConfig(fixture);
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "ssh",
      name: "Fixture SSH",
      config: sshConfig,
    });
    try {
      const acquired = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });

      expect(acquired.lease.status).toBe("active");
      expect(acquired.lease.providerLeaseId).toContain(`ssh://${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`);
      expect(acquired.lease.metadata).toMatchObject({
        driver: "ssh",
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        remoteWorkspacePath: sshConfig.remoteWorkspacePath,
        remoteCwd: sshConfig.remoteWorkspacePath,
      });

      const released = await runtime.releaseRunLeases(runId);

      expect(released).toHaveLength(1);
      expect(released[0]?.environment.driver).toBe("ssh");
      expect(released[0]?.lease.status).toBe("released");
    } finally {
    }
  });

  it("acquires and releases a fake sandbox run lease through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.providerLeaseId).toMatch(new RegExp(`^sandbox://fake/${runId}/[0-9a-f-]{36}$`));
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(acquired.lease.metadata).toMatchObject({
      driver: "sandbox",
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: true,
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.environment.driver).toBe("sandbox");
    expect(released[0]?.lease.status).toBe("released");
  });

  it("uses plugin-backed sandbox config for execute and release", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const fakePluginConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
      remoteCwd: "/configured/workspace",
      shellCommand: "bash",
      pluginKey: "provider-config-key",
    };
    const environment = {
      ...baseEnvironment,
      name: "Fake Plugin Sandbox",
      driver: "sandbox",
      config: fakePluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: fakePluginConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.fake-plugin-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.fake-plugin-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Plugin Sandbox Provider",
        description: "Test fake plugin provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(params.config).not.toHaveProperty("provider");
        if (method === "environmentAcquireLease") {
          expect(params.config).toEqual(expect.objectContaining({
            image: "fake:test",
            timeoutMs: 1234,
            reuseLease: false,
            remoteCwd: "/configured/workspace",
            shellCommand: "bash",
            pluginKey: "provider-config-key",
          }));
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          expect(params.config).toEqual(expect.objectContaining({
            image: "fake:test",
            timeoutMs: 1234,
            reuseLease: false,
            remoteCwd: "/configured/workspace",
            shellCommand: "bash",
            pluginKey: "provider-config-key",
          }));
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          };
        }
        if (method === "environmentReleaseLease") {
          expect(params.config).toEqual({
            image: "fake:test",
            timeoutMs: 1234,
            reuseLease: false,
            remoteCwd: "/configured/workspace",
            shellCommand: "bash",
          });
          expect(params.config).not.toHaveProperty("agentId");
          expect(params.config).not.toHaveProperty("driver");
          expect(params.config).not.toHaveProperty("executionWorkspaceMode");
          expect(params.config).not.toHaveProperty("pluginId");
          expect(params.config).not.toHaveProperty("pluginKey");
          expect(params.config).not.toHaveProperty("providerMetadata");
          expect(params.config).not.toHaveProperty("provider");
          expect(params.config).not.toHaveProperty("reusableSandboxLease");
          expect(params.config).not.toHaveProperty("sandboxProviderPlugin");
          expect(params.config).not.toHaveProperty("workspaceRealization");
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "printf",
      args: ["ok"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
    });

    const {
      sandboxProviderConfig: _storedProviderConfig,
      leaseScopedSecretBindings: _leaseScopedSecretBindings,
      ...legacyMetadata
    } = acquired.lease.metadata ?? {};
    await environmentService(db).updateLeaseMetadata(acquired.lease.id, {
      ...legacyMetadata,
      agentId,
      remoteCwd: fakePluginConfig.remoteCwd,
      shellCommand: fakePluginConfig.shellCommand,
      pluginKey: fakePluginConfig.pluginKey,
      reusableSandboxLease: {
        version: 1,
        environmentId: environment.id,
      },
      workspaceRealization: {
        remote: { path: "/configured/workspace" },
      },
    });
    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.anything(), 91000);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.anything(), 91234);
  });

  it("keeps plugin sandbox cleanup on its lease-scoped secret after the environment changes", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.secure-sandbox-provider",
      packageName: "@acme/secure-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.secure-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Secure Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "secure-plugin",
            kind: "sandbox_provider",
            displayName: "Secure Sandbox",
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string" },
                apiKey: { type: "string", format: "secret-ref" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(params.config.apiKey).toBe("resolved-provider-key");
        expect(params.config).not.toHaveProperty("provider");
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "secure-plugin",
              template: "base",
              apiKey: "resolved-provider-key",
              timeoutMs: 1234,
              reuseLease: false,
              sandboxId: "sandbox-1",
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    expect(acquired.lease.metadata).toMatchObject({
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      sandboxId: "sandbox-1",
      leaseScopedSecretBindings: true,
    });
    const replacementSecret = await secretService(db).create(companyId, {
      name: `replacement-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "replacement-provider-key",
    });
    await secretService(db).syncSecretRefsForTarget(
      companyId,
      { targetType: "environment", targetId: environment.id },
      [{ secretId: replacementSecret.id, configPath: "apiKey" }],
      { replaceAll: true },
    );
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: { ...providerConfig, apiKey: replacementSecret.id },
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "printf",
      args: ["ok"],
      cwd: "/workspace",
      env: {},
    });

    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }), 91234);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }), 91234);
    await expect(db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, acquired.lease.id)))
      .resolves.toHaveLength(0);
  });

  it("queues provider cleanup when sandbox lease handoff fails after acquisition", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const originalSecret = await secretService(db).create(companyId, {
      name: `acquire-handoff-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "original-provider-key",
    });
    const replacementSecret = await secretService(db).create(companyId, {
      name: `replacement-handoff-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "replacement-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: originalSecret.id,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Acquire Handoff Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: originalSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.acquire-handoff-sandbox-provider",
      packageName: "@acme/acquire-handoff-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.acquire-handoff-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acquire Handoff Sandbox Provider",
        description: "Test acquisition compensation",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{
          driverKey: "secure-plugin",
          kind: "sandbox_provider",
          displayName: "Secure Plugin",
          configSchema: {
            type: "object",
            properties: {
              template: { type: "string" },
              apiKey: { type: "string", format: "secret-ref" },
              reuseLease: { type: "boolean" },
            },
          },
        }],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          await secretService(db).syncSecretRefsForTarget(
            companyId,
            { targetType: "environment", targetId: environment.id },
            [{ secretId: replacementSecret.id, configPath: "apiKey" }],
            { replaceAll: true },
          );
          return {
            providerLeaseId: "orphaned-provider-lease",
            metadata: { provider: "secure-plugin", template: "base", reuseLease: false },
          };
        }
        if (method === "environmentReleaseLease") {
          throw new Error("provider cleanup unavailable");
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    })).rejects.toThrow('Sandbox secret binding changed while acquiring lease at "apiKey".');

    await expect(db.select().from(environmentLeases)).resolves.toEqual([
      expect.objectContaining({
        providerLeaseId: "orphaned-provider-lease",
        status: "pending_cleanup",
        cleanupStatus: "failed",
        failureReason: "acquire_handoff_failed",
        metadata: expect.objectContaining({ pendingCleanupReleaseStatus: "expired" }),
      }),
    ]);
    expect(workerManager.call).toHaveBeenCalledTimes(1);
  });

  it("cleans up a provider lease reported by a structured plugin acquisition error", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "structured-error-plugin",
      image: "structured:test",
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Structured Error Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.structured-error-sandbox-provider",
      packageName: "@acme/structured-error-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.structured-error-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Structured Error Sandbox Provider",
        description: "Test structured acquisition failure cleanup",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{
          driverKey: "structured-error-plugin",
          kind: "sandbox_provider",
          displayName: "Structured Error Plugin",
          configSchema: { type: "object" },
        }],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const acquisitionError = new JsonRpcCallError({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "provider setup failed after creation",
      data: { providerLeaseId: "structured-failed-acquisition" },
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, _params: any) => {
        if (method === "environmentAcquireLease") throw acquisitionError;
        if (method === "environmentReleaseLease") return undefined;
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    })).rejects.toBe(acquisitionError);

    expect(workerManager.call.mock.calls.map((call) => call[1])).toEqual([
      "environmentAcquireLease",
      "environmentReleaseLease",
    ]);
    const acquireParams = workerManager.call.mock.calls[0]?.[2];
    const releaseParams = workerManager.call.mock.calls[1]?.[2];
    expect(releaseParams).toMatchObject({
      acquisitionId: acquireParams.acquisitionId,
      providerLeaseId: "structured-failed-acquisition",
    });
    const [terminal] = await db.select().from(environmentLeases);
    expect(terminal).toMatchObject({
      status: "expired",
      providerLeaseId: "structured-failed-acquisition",
      cleanupStatus: "success",
      metadata: {
        acquisitionId: acquireParams.acquisitionId,
      },
    });
  });

  it("still compensates a sandbox provider lease when recording the cleanup lease fails", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const environment = {
      ...baseEnvironment,
      name: "Unrecorded Sandbox Cleanup",
      driver: "sandbox",
      config: {
        provider: "unrecorded-sandbox-provider",
        reuseLease: false,
      },
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: environment.config,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.unrecorded-sandbox-provider",
      packageName: "@acme/unrecorded-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.unrecorded-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Unrecorded Sandbox Provider",
        description: "Test cleanup when sandbox lease persistence fails",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{
          driverKey: "unrecorded-sandbox-provider",
          kind: "sandbox_provider",
          displayName: "Unrecorded Sandbox Provider",
          configSchema: { type: "object" },
        }],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const acquisitionError = new JsonRpcCallError({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "sandbox setup failed after creation",
      data: { providerLeaseId: "unrecorded-sandbox-provider-lease" },
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          await db.delete(environments).where(eq(environments.id, environment.id));
          throw acquisitionError;
        }
        if (method === "environmentReleaseLease") throw new Error("provider cleanup unavailable");
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    })).rejects.toBe(acquisitionError);

    expect(workerManager.call.mock.calls.map((call) => call[1])).toEqual([
      "environmentAcquireLease",
      "environmentReleaseLease",
    ]);
    await expect(db.select().from(environmentLeases)).resolves.toHaveLength(0);
  });

  it("falls back to current config when a lease-scoped sandbox secret is deleted", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const originalSecret = await secretService(db).create(companyId, {
      name: `deleted-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "original-provider-key",
    });
    const replacementSecret = await secretService(db).create(companyId, {
      name: `current-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "current-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: originalSecret.id,
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Deleted Secret Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: originalSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.deleted-secret-sandbox-provider",
      packageName: "@acme/deleted-secret-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.deleted-secret-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Deleted Secret Sandbox Provider",
        description: "Test schema-driven provider fallback",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "secure-plugin",
            kind: "sandbox_provider",
            displayName: "Secure Sandbox",
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string" },
                apiKey: { type: "string", format: "secret-ref" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          expect(params.config.apiKey).toBe("original-provider-key");
          return {
            providerLeaseId: "sandbox-deleted-secret",
            metadata: {
              provider: "secure-plugin",
              template: "base",
              timeoutMs: 1234,
              reuseLease: false,
            },
          };
        }
        if (method === "environmentReleaseLease") {
          expect(params.config.apiKey).toBe("current-provider-key");
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await secretService(db).syncSecretRefsForTarget(
      companyId,
      { targetType: "environment", targetId: environment.id },
      [{ secretId: replacementSecret.id, configPath: "apiKey" }],
      { replaceAll: true },
    );
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: { ...providerConfig, apiKey: replacementSecret.id },
    });
    await secretService(db).remove(originalSecret.id);
    await expect(db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, acquired.lease.id)))
      .resolves.toHaveLength(0);

    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "current-provider-key",
      }),
    }), 91234);
  });

  it("waits briefly for a ready sandbox provider plugin worker to come online", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Eventually Running Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.eventually-running-sandbox-provider",
      packageName: "@acme/eventually-running-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.eventually-running-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Eventually Running Sandbox Provider",
        description: "Test plugin worker startup grace period",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    let runningChecks = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => {
        if (id !== pluginId) return false;
        runningChecks += 1;
        return runningChecks >= 3;
      }),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
      pluginWorkerReadyTimeoutMs: 25,
      pluginWorkerReadyPollMs: 1,
    });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-1");
    expect(workerManager.isRunning).toHaveBeenCalledTimes(3);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 91234);
  });

  it("extends plugin-backed sandbox lease RPC timeouts from provider config", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1_234,
      bridgeRequestTimeoutMs: 40_000,
      reuseLease: false,
    };
    const environment = {
      ...baseEnvironment,
      name: "Long Lease Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.long-lease-sandbox-provider",
      packageName: "@acme/long-lease-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.long-lease-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Long Lease Sandbox Provider",
        description: "Test plugin worker acquire timeout",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1_234,
              bridgeRequestTimeoutMs: 40_000,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-1");
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentAcquireLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        config: {
          image: "fake:test",
          timeoutMs: 1_234,
          bridgeRequestTimeoutMs: 40_000,
          reuseLease: false,
        },
      }),
      130_000,
    );
  });

  it("retires the reusable plugin lease and its bindings after a successful handoff", async () => {
    const { pluginId, companyId, agentId, environment, runId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    const acquisitionId = randomUUID();
    await db.update(environmentLeases)
      .set({ metadata: { ...reusableLease.metadata, acquisitionId } })
      .where(eq(environmentLeases.id, reusableLease.id));
    const cleanupSecret = await secretService(db).create(companyId, {
      name: `reusable-handoff-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "handoff-secret",
    });
    await secretService(db).createBinding({
      companyId,
      secretId: cleanupSecret.id,
      targetType: "environment_lease",
      targetId: reusableLease.id,
      configPath: "apiKey",
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: reusableLease.providerLeaseId,
            metadata: reusableLease.metadata,
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.id).not.toBe(reusableLease.id);
    expect(acquired.lease.providerLeaseId).toBe(reusableLease.providerLeaseId);
    expect(acquired.lease.metadata?.acquisitionId).toBe(acquisitionId);
    expect(workerManager.call).toHaveBeenCalledOnce();
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
    await expect(db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, reusableLease.id)))
      .resolves.toHaveLength(0);
  });

  it("destroys the old reusable plugin lease when resume returns a different provider lease", async () => {
    const { pluginId, companyId, agentId, environment, runId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: "replacement-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
            },
          };
        }
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease).toMatchObject({
      status: "active",
      leasePolicy: "reuse_by_environment",
      providerLeaseId: "replacement-plugin-lease",
    });
    expect(workerManager.call).toHaveBeenNthCalledWith(
      1,
      pluginId,
      "environmentResumeLease",
      expect.objectContaining({ providerLeaseId: "reusable-plugin-lease" }),
      91234,
    );
    expect(workerManager.call).toHaveBeenNthCalledWith(
      2,
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({ providerLeaseId: "reusable-plugin-lease" }),
      91234,
    );
    await expect(environmentService(db).getLeaseById(acquired.lease.id)).resolves.toMatchObject({
      status: "active",
      leasePolicy: "reuse_by_environment",
      providerLeaseId: "replacement-plugin-lease",
    });
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "resume_failed",
      cleanupStatus: "success",
    });
  });

  it("falls back to acquire when plugin-backed sandbox lease resume throws", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.fake-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                image: { type: "string" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const staleAcquisitionId = randomUUID();
    const staleLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.fake-sandbox-provider",
        sandboxProviderPlugin: true,
        acquisitionId: staleAcquisitionId,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          throw new Error("stale sandbox");
        }
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentResumeLease", expect.objectContaining({
      driverKey: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
    }), 91234);
    expect(workerManager.call).toHaveBeenNthCalledWith(2, pluginId, "environmentDestroyLease", expect.objectContaining({
      driverKey: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
    }), 91234);
    expect(workerManager.call).toHaveBeenNthCalledWith(3, pluginId, "environmentAcquireLease", expect.objectContaining({
      acquisitionId: expect.any(String),
      driverKey: "fake-plugin",
      config: {
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
      },
      agentId,
      executionWorkspaceId,
      runId,
    }), 91234);
    const fallbackAcquireParams = workerManager.call.mock.calls[2]?.[2];
    expect(fallbackAcquireParams.acquisitionId).not.toBe(staleAcquisitionId);
    expect(acquired.lease.metadata?.acquisitionId).toBe(fallbackAcquireParams.acquisitionId);
    await expect(environmentService(db).getLeaseById(staleLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
  });

  it("does not resume released reusable plugin sandbox leases after provider config drift", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "template-a",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.fake-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Fake Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                image: { type: "string" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `lease-${params.config.image}`,
            metadata: {
              provider: "fake-plugin",
              image: params.config.image,
              timeoutMs: params.config.timeoutMs,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const first = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    expect(first.lease.metadata?.reusableSandboxLease).toMatchObject({
      provider: "fake-plugin",
      leaseFingerprint: expect.objectContaining({
        category: "lease",
        fingerprint: expect.stringMatching(/^v1:sha256:[a-f0-9]{64}$/),
      }),
    });
    await runtimeWithPlugin.releaseRunLeases(runId);

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const updatedEnvironment = {
      ...environment,
      config: {
        ...providerConfig,
        image: "template-b",
      },
    };
    await environmentService(db).update(environment.id, {
      config: updatedEnvironment.config,
    });

    const second = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment: updatedEnvironment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(second.lease.providerLeaseId).toBe("lease-template-b");
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.objectContaining({
      providerLeaseId: "lease-template-a",
    }), 91234);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
  });

  it("claims a fingerprint-mismatched reusable lease before destroying it", async () => {
    const { pluginId, companyId, agentId, environment, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    await environmentService(db).releaseLease(reusableLease.id, "released", {
      expectedStatus: "active",
    });

    const createRun = async () => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "running",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return runId;
    };
    const cleanupRunId = await createRun();
    const resumeRunId = await createRun();
    const driftedEnvironment = {
      ...environment,
      config: {
        ...environment.config,
        image: "fake:next",
      },
    };
    await environmentService(db).update(environment.id, {
      config: driftedEnvironment.config,
    });

    let destroyStarted!: () => void;
    const destroyStartedPromise = new Promise<void>((resolve) => {
      destroyStarted = resolve;
    });
    let finishDestroy!: () => void;
    const destroyBlocked = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentDestroyLease") {
          destroyStarted();
          await destroyBlocked;
          return undefined;
        }
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `fresh-${params.config.image}-${params.acquisitionId}`,
            metadata: {
              provider: "fake-plugin",
              image: params.config.image,
              timeoutMs: 1234,
              reuseLease: true,
            },
          };
        }
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: "reusable-plugin-lease",
            metadata: params.leaseMetadata,
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const cleanupAndAcquire = runtimeWithPlugin.acquireRunLease({
      companyId,
      environment: driftedEnvironment,
      issueId: null,
      agentId,
      heartbeatRunId: cleanupRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    await destroyStartedPromise;

    try {
      const [claimedLease] = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, reusableLease.id));
      expect(claimedLease).toMatchObject({
        status: "pending_cleanup",
        cleanupClaimId: expect.any(String),
      });
      const overlappingAcquire = await runtimeWithPlugin.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        agentId,
        heartbeatRunId: resumeRunId,
        persistedExecutionWorkspace: {
          id: executionWorkspaceId,
          mode: "shared_workspace",
        },
      });
      expect(overlappingAcquire.lease.providerLeaseId).not.toBe("reusable-plugin-lease");
      expect(workerManager.call.mock.calls.map((call) => call[1])).not.toContain("environmentResumeLease");
    } finally {
      finishDestroy();
    }

    await expect(cleanupAndAcquire).resolves.toMatchObject({
      lease: expect.objectContaining({
        providerLeaseId: expect.stringContaining("fresh-fake:next-"),
      }),
    });
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
  });

  it("does not resume released reusable plugin sandbox leases after secret version drift", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.secure-sandbox-provider",
      packageName: "@acme/secure-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.secure-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Secure Sandbox Provider",
        description: "Test schema-driven provider",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "secure-plugin",
            kind: "sandbox_provider",
            displayName: "Secure Sandbox",
            supportsReusableLeases: true,
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string" },
                apiKey: { type: "string", format: "secret-ref" },
                timeoutMs: { type: "number" },
                reuseLease: { type: "boolean" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `lease-${params.config.apiKey}`,
            metadata: {
              provider: "secure-plugin",
              template: params.config.template,
              apiKey: params.config.apiKey,
              timeoutMs: params.config.timeoutMs,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const first = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    await runtimeWithPlugin.releaseRunLeases(runId);
    await secretService(db).rotate(apiSecret.id, { value: "rotated-provider-key" });

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const second = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(second.lease.providerLeaseId).toBe("lease-rotated-provider-key");
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.objectContaining({
      providerLeaseId: "lease-resolved-provider-key",
    }), 91234);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
    const firstMetadata = JSON.stringify(first.lease.metadata);
    expect(firstMetadata).not.toContain("resolved-provider-key");
    expect(firstMetadata).not.toContain("rotated-provider-key");
  });

  it("preserves active reusable sandbox leases held by another running run", async () => {
    const { pluginId, companyId, agentId, environment, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(workerManager.call).toHaveBeenCalledOnce();
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      agentId,
      executionWorkspaceId,
      runId: nextRunId,
    }), 91234);
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "active",
      cleanupStatus: null,
    });
  });

  it("does not retain or resume plugin-backed sandbox leases unless the provider opts in", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment = {
      ...baseEnvironment,
      name: "Non-reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.non-reusable-sandbox-provider",
      packageName: "@acme/non-reusable-sandbox-provider",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.non-reusable-sandbox-provider",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Non-reusable Sandbox Provider",
        description: "Test provider without reusable lease support",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Non-reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "old-plugin-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 91234);
  });

  it("destroys scoped reusable plugin-backed sandbox leases", async () => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const destroyed = await runtimeWithPlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "execution_workspace_closed",
    });

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]?.lease.id).toBe(reusableLease.id);
    expect(destroyed[0]?.lease.status).toBe("expired");
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      91234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "success",
    });
  });

  it("does not resume a finalized reusable lease after terminal destroy intent wins", async () => {
    const {
      pluginId,
      companyId,
      agentId,
      environment,
      runId,
      executionWorkspaceId,
      reusableLease,
    } = await seedReusablePluginSandboxLease();
    await db
      .update(environmentLeases)
      .set({
        status: "released",
        metadata: {
          ...(reusableLease.metadata ?? {}),
          pendingCleanupReleaseStatus: "expired",
        },
      })
      .where(eq(environmentLeases.id, reusableLease.id));
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-after-terminal-intent",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-after-terminal-intent");
    expect(workerManager.call.mock.calls.map(([, method]) => method)).toEqual([
      "environmentAcquireLease",
    ]);
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "released",
      metadata: expect.objectContaining({ pendingCleanupReleaseStatus: "expired" }),
    });
  });

  it.each(["run release", "workspace destroy"] as const)(
    "serializes $winner without losing terminal destroy intent",
    async (winner) => {
      const { pluginId, companyId, runId, executionWorkspaceId, reusableLease } =
        await seedReusablePluginSandboxLease();
      let finishCleanup!: () => void;
      const cleanupBlocked = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      const workerManager = {
        isRunning: vi.fn((id: string) => id === pluginId),
        call: vi.fn(async () => await cleanupBlocked),
      } as unknown as PluginWorkerManager;
      const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

      const winningCleanup = winner === "run release"
        ? runtimeWithPlugin.releaseRunLeases(runId)
        : runtimeWithPlugin.destroyReusableSandboxLeases({ companyId, executionWorkspaceId });
      await vi.waitFor(() => expect(workerManager.call).toHaveBeenCalledTimes(1));
      const losingCleanup = winner === "run release"
        ? await runtimeWithPlugin.destroyReusableSandboxLeases({ companyId, executionWorkspaceId })
        : await runtimeWithPlugin.releaseRunLeases(runId);

      expect(losingCleanup).toEqual([]);
      expect(workerManager.call).toHaveBeenCalledTimes(1);
      finishCleanup();
      const winningResult = await winningCleanup;

      expect(winningResult).toHaveLength(1);
      if (winner === "run release") {
        expect(winningResult[0]?.lease.status).toBe("pending_cleanup");
        await db
          .update(environmentLeases)
          .set({ updatedAt: new Date(0) })
          .where(eq(environmentLeases.id, reusableLease.id));
        await expect(runtimeWithPlugin.retryPendingSandboxCleanups()).resolves.toEqual({
          attempted: 1,
          cleaned: 1,
          pending: 0,
        });
        expect(workerManager.call.mock.calls.map(([, method]) => method)).toEqual([
          "environmentReleaseLease",
          "environmentDestroyLease",
        ]);
      } else {
        expect(workerManager.call).toHaveBeenCalledTimes(1);
        expect(workerManager.call).toHaveBeenCalledWith(
          pluginId,
          "environmentDestroyLease",
          expect.objectContaining({ providerLeaseId: "reusable-plugin-lease" }),
          91234,
        );
      }
      await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
        status: "expired",
        cleanupStatus: "success",
      });
    },
  );

  it("defers a thrown reusable release claim and continues cleaning later rows", async () => {
    const { companyId, environment, runId } = await seedEnvironment();
    const environmentsSvc = environmentService(db);
    const seededLeases = await Promise.all([
      environmentsSvc.acquireLease({
        companyId,
        environmentId: environment.id,
        heartbeatRunId: runId,
        leasePolicy: "reuse_by_environment",
        providerLeaseId: "reusable-row-one",
        metadata: { driver: environment.driver },
      }),
      environmentsSvc.acquireLease({
        companyId,
        environmentId: environment.id,
        heartbeatRunId: runId,
        leasePolicy: "reuse_by_environment",
        providerLeaseId: "reusable-row-two",
        metadata: { driver: environment.driver },
      }),
    ]);
    let failedLeaseId: string | null = null;
    let failedLeaseBeforeLaterCleanup: typeof environmentLeases.$inferSelect | null = null;
    const releaseRunLease = vi.fn(async (input) => {
      if (!failedLeaseId) {
        failedLeaseId = input.lease.id;
        throw new Error("custom reusable cleanup failed");
      }

      [failedLeaseBeforeLaterCleanup] = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, failedLeaseId));
      return await environmentsSvc.releaseLease(input.lease.id, input.status, {
        cleanupStatus: "success",
        expectedCleanupClaimId: input.cleanupClaimId,
        expectedStatus: "pending_cleanup",
      });
    });
    const isolatedRuntime = environmentRuntimeService(db, {
      drivers: [
        {
          driver: environment.driver,
          acquireRunLease: async () => {
            throw new Error("acquire should not be called");
          },
          releaseRunLease,
        },
      ],
    });

    const released = await isolatedRuntime.releaseRunLeases(runId);

    expect(releaseRunLease).toHaveBeenCalledTimes(2);
    expect(released).toHaveLength(1);
    for (const [input] of releaseRunLease.mock.calls) {
      expect(input.lease.status).toBe("pending_cleanup");
      expect(input.cleanupClaimId).toEqual(expect.any(String));
    }
    expect(new Set(releaseRunLease.mock.calls.map(([input]) => input.lease.id))).toEqual(
      new Set(seededLeases.map((lease) => lease.id)),
    );
    expect(failedLeaseBeforeLaterCleanup).toMatchObject({
      status: "pending_cleanup",
      failureReason: "cleanup_release_failed",
      cleanupStatus: "failed",
      cleanupClaimId: null,
      cleanupClaimedAt: null,
    });
    expect(released[0]?.lease).toMatchObject({
      status: "released",
      cleanupStatus: "success",
    });
    const [failedLease] = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, failedLeaseId!));
    expect(failedLease).toMatchObject({
      status: "pending_cleanup",
      failureReason: "cleanup_release_failed",
      cleanupStatus: "failed",
      cleanupClaimId: null,
      cleanupClaimedAt: null,
    });
  });

  it("surfaces a thrown ephemeral release instead of silently leaving an active lease", async () => {
    const { companyId, environment, runId } = await seedEnvironment();
    const environmentsSvc = environmentService(db);
    const lease = await environmentsSvc.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      leasePolicy: "ephemeral",
      providerLeaseId: "ephemeral-throwing-release",
      metadata: { driver: environment.driver },
    });
    const releaseRunLease = vi.fn(async () => {
      throw new Error("ephemeral cleanup failed");
    });
    const isolatedRuntime = environmentRuntimeService(db, {
      drivers: [
        {
          driver: environment.driver,
          acquireRunLease: async () => {
            throw new Error("acquire should not be called");
          },
          releaseRunLease,
        },
      ],
    });

    await expect(isolatedRuntime.releaseRunLeases(runId)).rejects.toThrow("ephemeral cleanup failed");

    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    await expect(environmentsSvc.getLeaseById(lease.id)).resolves.toMatchObject({
      status: "active",
    });
    const [leaseRow] = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, lease.id));
    expect(leaseRow).toMatchObject({
      status: "active",
      cleanupClaimId: null,
      cleanupClaimedAt: null,
    });
  });

  it("retries a failed normal reusable release without destroying the provider lease", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    const unavailableWorkerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        expect(method).toBe("environmentReleaseLease");
        throw new Error("provider release unavailable");
      }),
    } as unknown as PluginWorkerManager;
    const unavailableRuntime = environmentRuntimeService(db, {
      pluginWorkerManager: unavailableWorkerManager,
    });

    const pending = await unavailableRuntime.releaseRunLeases(runId);

    expect(pending).toHaveLength(1);
    expect(pending[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "pending_cleanup",
      cleanupStatus: "failed",
      metadata: expect.objectContaining({ pendingCleanupReleaseStatus: "released" }),
    });
    await db
      .update(environmentLeases)
      .set({ updatedAt: new Date(0) })
      .where(eq(environmentLeases.id, reusableLease.id));
    const recoveredWorkerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        expect(method).toBe("environmentReleaseLease");
      }),
    } as unknown as PluginWorkerManager;
    const recoveredRuntime = environmentRuntimeService(db, {
      pluginWorkerManager: recoveredWorkerManager,
    });

    await expect(recoveredRuntime.retryPendingSandboxCleanups()).resolves.toEqual({
      attempted: 1,
      cleaned: 1,
      pending: 0,
    });
    expect(recoveredWorkerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentReleaseLease",
      expect.objectContaining({ providerLeaseId: "reusable-plugin-lease" }),
      91234,
    );
    expect(recoveredWorkerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.anything(),
      expect.anything(),
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "released",
      cleanupStatus: "success",
    });
  });

  it("destroys reusable plugin-backed sandbox leases when a run fails", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        expect(method).toBe("environmentDestroyLease");
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const destroyed = await runtimeWithPlugin.releaseRunLeases(runId, "failed");

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "expired",
      failureReason: "adapter_or_run_failure",
      cleanupStatus: "success",
    });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({ providerLeaseId: "reusable-plugin-lease" }),
      91234,
    );
  });

  it("destroys legacy failed reusable plugin-backed sandbox leases", async () => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    await db
      .update(environmentLeases)
      .set({ status: "failed", failureReason: "adapter_or_run_failure" })
      .where(eq(environmentLeases.id, reusableLease.id));
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        expect(method).toBe("environmentDestroyLease");
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const destroyed = await runtimeWithPlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
    });

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "expired",
      cleanupStatus: "success",
    });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({ providerLeaseId: "reusable-plugin-lease" }),
      91234,
    );
  });

  it("retries failed ephemeral plugin sandbox cleanup", async () => {
    const { pluginId, lease, pending } = await seedPendingPluginSandboxCleanup("failed-plugin-lease");

    expect(pending[0]?.lease).toMatchObject({
      id: lease.id,
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "adapter_or_run_failure",
      metadata: expect.objectContaining({ pendingCleanupReleaseStatus: "failed" }),
    });

    const recoveredWorkerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => undefined),
    } as unknown as PluginWorkerManager;
    const recoveredRuntime = environmentRuntimeService(db, {
      pluginWorkerManager: recoveredWorkerManager,
    });
    const result = await recoveredRuntime.retryPendingSandboxCleanups();

    expect(result).toEqual({ attempted: 1, cleaned: 1, pending: 0 });
    expect(recoveredWorkerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentReleaseLease",
      expect.objectContaining({ providerLeaseId: "failed-plugin-lease" }),
      undefined,
    );
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "failed",
      cleanupStatus: "success",
    });
    await expect(
      db.select().from(activityLog).where(eq(activityLog.entityId, lease.id)),
    ).resolves.toContainEqual(expect.objectContaining({
      companyId: lease.companyId,
      actorType: "system",
      actorId: "environment_cleanup_retry",
      action: "environment.lease_cleanup_completed",
      entityType: "environment_lease",
      entityId: lease.id,
      details: expect.objectContaining({
        environmentId: lease.environmentId,
        provider: "fake-plugin",
        previousStatus: "pending_cleanup",
        status: "failed",
        cleanupStatus: "success",
      }),
    }));
  });

  it("defers unavailable cleanup rows so they cannot starve the retry batch", async () => {
    const { pluginId, lease } = await seedPendingPluginSandboxCleanup("recoverable-plugin-lease");
    const [pendingRow] = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, lease.id));
    expect(pendingRow).toBeDefined();
    await db.insert(environmentLeases).values(
      Array.from({ length: 10 }, (_, index) => ({
        ...pendingRow!,
        id: randomUUID(),
        metadata: { ...pendingRow!.metadata, driver: "missing-driver" },
        providerLeaseId: `missing-driver-plugin-lease-${index}`,
      })),
    );
    await db
      .update(environmentLeases)
      .set({ updatedAt: new Date(1) })
      .where(eq(environmentLeases.id, lease.id));
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => undefined),
    } as unknown as PluginWorkerManager;
    const recoveredRuntime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(recoveredRuntime.retryPendingSandboxCleanups()).resolves.toEqual({
      attempted: 0,
      cleaned: 0,
      pending: 0,
    });
    expect(workerManager.call).not.toHaveBeenCalled();
    const [pendingLease] = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.providerLeaseId, "missing-driver-plugin-lease-0"));
    expect(pendingLease).toMatchObject({
      status: "pending_cleanup",
      cleanupClaimId: null,
      cleanupClaimedAt: null,
    });
    expect(pendingLease!.updatedAt.getTime()).toBeGreaterThan(0);

    await expect(recoveredRuntime.retryPendingSandboxCleanups()).resolves.toEqual({
      attempted: 1,
      cleaned: 1,
      pending: 0,
    });
    expect(workerManager.call).toHaveBeenCalledTimes(1);
  });

  it("does not let a late failed initial cleanup overwrite a successful release", async () => {
    const { pluginId, lease, runId } = await seedPluginSandboxLease("overlapping-initial-release");
    let failFirstCleanup!: (error: Error) => void;
    const firstCleanupBlocked = new Promise<void>((_resolve, reject) => {
      failFirstCleanup = reject;
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn()
        .mockImplementationOnce(async () => await firstCleanupBlocked)
        .mockResolvedValueOnce(undefined),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const lateFailure = runtimeWithPlugin.releaseRunLeases(runId);
    await vi.waitFor(() => expect(workerManager.call).toHaveBeenCalledTimes(1));
    const successfulRelease = await runtimeWithPlugin.releaseRunLeases(runId);
    failFirstCleanup(new Error("late provider failure"));
    const failedRelease = await lateFailure;

    expect(successfulRelease).toHaveLength(1);
    expect(failedRelease).toHaveLength(0);
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "released",
      cleanupStatus: "success",
    });
  });

  it("claims a pending sandbox cleanup once across overlapping retries", async () => {
    const { pluginId, lease } = await seedPendingPluginSandboxCleanup("concurrent-plugin-lease");
    let finishCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => await cleanupBlocked),
    } as unknown as PluginWorkerManager;
    const firstRetry = environmentRuntimeService(db, { pluginWorkerManager: workerManager })
      .retryPendingSandboxCleanups();
    const secondRetry = environmentRuntimeService(db, { pluginWorkerManager: workerManager })
      .retryPendingSandboxCleanups();

    await vi.waitFor(() => expect(workerManager.call).toHaveBeenCalledTimes(1));
    const wrongOwnerResult = await environmentService(db).releaseLease(lease.id, "failed", {
      expectedCleanupClaimId: randomUUID(),
    });
    expect(wrongOwnerResult).toBeNull();

    finishCleanup();
    const results = await Promise.all([firstRetry, secondRetry]);

    expect(results.reduce((total, result) => total + result.attempted, 0)).toBe(1);
    expect(results.reduce((total, result) => total + result.cleaned, 0)).toBe(1);
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "failed",
      cleanupStatus: "success",
    });
  });

  it("does not destroy a pending reusable lease claimed by the cleanup retry", async () => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    const offlineRuntime = environmentRuntimeService(db, {
      pluginWorkerManager: {
        isRunning: vi.fn(() => false),
        call: vi.fn(),
      } as unknown as PluginWorkerManager,
    });
    await offlineRuntime.destroyReusableSandboxLeases({ companyId, executionWorkspaceId });
    await db
      .update(environmentLeases)
      .set({ updatedAt: new Date(0) })
      .where(eq(environmentLeases.id, reusableLease.id));

    let finishCleanup!: () => void;
    const cleanupBlocked = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        expect(method).toBe("environmentDestroyLease");
        await cleanupBlocked;
      }),
    } as unknown as PluginWorkerManager;
    const recoveredRuntime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const retry = recoveredRuntime.retryPendingSandboxCleanups();
    await vi.waitFor(() => expect(workerManager.call).toHaveBeenCalledTimes(1));

    const concurrentDestroy = await recoveredRuntime.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
    });

    expect(concurrentDestroy).toEqual([]);
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    finishCleanup();
    await expect(retry).resolves.toEqual({ attempted: 1, cleaned: 1, pending: 0 });
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
  });

  it("automatically retries reusable plugin sandbox destroy and deletes lease bindings", async () => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();

    const offlineWorkerManager = {
      isRunning: vi.fn(() => false),
      call: vi.fn(),
    } as unknown as PluginWorkerManager;
    const runtimeWithOfflinePlugin = environmentRuntimeService(db, {
      pluginWorkerManager: offlineWorkerManager,
    });

    const pending = await runtimeWithOfflinePlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "execution_workspace_closed",
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.lease.id).toBe(reusableLease.id);
    expect(pending[0]?.lease.status).toBe("pending_cleanup");
    expect(offlineWorkerManager.call).not.toHaveBeenCalled();
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "failed",
    });
    const cleanupSecret = await secretService(db).create(companyId, {
      name: `reusable-cleanup-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "cleanup-secret",
    });
    await secretService(db).createBinding({
      companyId,
      secretId: cleanupSecret.id,
      targetType: "environment_lease",
      targetId: reusableLease.id,
      configPath: "apiKey",
    });
    await db
      .update(environmentLeases)
      .set({ updatedAt: new Date(0) })
      .where(eq(environmentLeases.id, reusableLease.id));

    const recoveredWorkerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithRecoveredPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: recoveredWorkerManager,
    });

    const retried = await runtimeWithRecoveredPlugin.retryPendingSandboxCleanups();

    expect(retried).toEqual({ attempted: 1, cleaned: 1, pending: 0 });
    expect(recoveredWorkerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      91234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "success",
    });
    await expect(db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, reusableLease.id)))
      .resolves.toHaveLength(0);
  });

  it("releases a sandbox run lease from metadata after the environment config changes", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.lease.id).toBe(acquired.lease.id);
    expect(released[0]?.lease.status).toBe("released");
  });

  it("does not reuse a sandbox lease owned by a different agent for the same execution workspace", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });
    const otherAgentId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const pluginId = randomUUID();
    const projectId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Existing workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            kind: "sandbox_provider",
            displayName: "Fake Plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "other-agent-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        template: "base",
        reuseLease: true,
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-agent-lease",
            metadata: {
              provider: "fake-plugin",
              template: "base",
              reuseLease: true,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId: otherAgentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-agent-lease");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      agentId: otherAgentId,
      executionWorkspaceId,
    }));
  });

  it("delegates plugin environment leases through the plugin worker manager", async () => {
    const pluginId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-1",
            expiresAt,
            metadata: {
              driver: "local",
              pluginId: "provider-plugin-id",
              pluginKey: "provider.plugin",
              driverKey: "provider-driver",
              executionWorkspaceMode: "provider-mode",
              provider: "test-provider",
              remoteCwd: "/workspace",
            },
          };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            displayName: "Fake plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", {
      acquisitionId: expect.any(String),
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: { template: "base" },
      runId,
      workspaceMode: undefined,
    });
    const acquireParams = workerManager.call.mock.calls[0]?.[2];
    expect(acquired.lease.providerLeaseId).toBe("plugin-lease-1");
    expect(acquired.lease.expiresAt?.toISOString()).toBe(expiresAt);
    expect(acquired.lease.metadata).toMatchObject({
      acquisitionId: acquireParams.acquisitionId,
      driver: "plugin",
      pluginId,
      pluginKey: "acme.environments",
      driverKey: "fake-plugin",
      executionWorkspaceMode: null,
      providerMetadata: {
        driver: "local",
        pluginId: "provider-plugin-id",
        pluginKey: "provider.plugin",
        driverKey: "provider-driver",
        executionWorkspaceMode: "provider-mode",
        provider: "test-provider",
        remoteCwd: "/workspace",
      },
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });

    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", {
      acquisitionId: acquireParams.acquisitionId,
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: {},
      providerLeaseId: "plugin-lease-1",
      leaseMetadata: expect.objectContaining({
        acquisitionId: acquireParams.acquisitionId,
        driver: "plugin",
        pluginId,
        providerMetadata: expect.objectContaining({
          driver: "local",
        }),
      }),
    });
    expect(released[0]?.lease.status).toBe("released");
  });

  it("cleans up a generic plugin lease reported by a structured acquisition error", async () => {
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Structured Failure Plugin Environment",
      config: {
        pluginKey: "acme.structured-environments",
        driverKey: "structured-driver",
        driverConfig: { template: "base" },
      },
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.structured-environments",
      packageName: "@acme/structured-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.structured-environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Structured Environments",
        description: "Test structured plugin acquisition failure cleanup",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{
          driverKey: "structured-driver",
          displayName: "Structured driver",
          configSchema: { type: "object" },
        }],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const acquisitionError = new JsonRpcCallError({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "generic provider setup failed after creation",
      data: { providerLeaseId: "structured-generic-acquisition" },
    });
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string, _params: any) => {
        if (method === "environmentAcquireLease") throw acquisitionError;
        if (method === "environmentReleaseLease") return undefined;
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    })).rejects.toBe(acquisitionError);

    expect(workerManager.call.mock.calls.map((call) => call[1])).toEqual([
      "environmentAcquireLease",
      "environmentReleaseLease",
    ]);
    const acquireParams = workerManager.call.mock.calls[0]?.[2];
    expect(workerManager.call.mock.calls[1]?.[2]).toMatchObject({
      acquisitionId: acquireParams.acquisitionId,
      providerLeaseId: "structured-generic-acquisition",
    });
    const [terminal] = await db.select().from(environmentLeases);
    expect(terminal).toMatchObject({
      status: "expired",
      providerLeaseId: "structured-generic-acquisition",
      cleanupStatus: "success",
      metadata: {
        acquisitionId: acquireParams.acquisitionId,
      },
    });
  });

  it("does not report failed generic plugin compensation when direct release succeeds", async () => {
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      config: {
        pluginKey: "acme.unrecorded-cleanup",
        driverKey: "unrecorded-driver",
        driverConfig: {},
      },
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.unrecorded-cleanup",
      packageName: "@acme/unrecorded-cleanup",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.unrecorded-cleanup",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Unrecorded cleanup",
        description: "Test cleanup when lease persistence fails",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{
          driverKey: "unrecorded-driver",
          displayName: "Unrecorded driver",
          configSchema: { type: "object" },
        }],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    const acquisitionError = new JsonRpcCallError({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "provider setup failed after creation",
      data: { providerLeaseId: "unrecorded-provider-lease" },
    });
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          await db.delete(environments).where(eq(environments.id, environment.id));
          throw acquisitionError;
        }
        if (method === "environmentReleaseLease") return undefined;
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const loggerError = vi.spyOn(logger, "error");
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    })).rejects.toBe(acquisitionError);

    expect(workerManager.call.mock.calls.map((call) => call[1])).toEqual([
      "environmentAcquireLease",
      "environmentReleaseLease",
    ]);
    expect(loggerError).not.toHaveBeenCalled();
    loggerError.mockRestore();
    await expect(db.select().from(environmentLeases)).resolves.toHaveLength(0);
  });

  it("delegates the full plugin environment lifecycle through the worker manager", async () => {
    const pluginId = randomUUID();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-full",
            metadata: {
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: "plugin-lease-full",
            metadata: {
              resumed: true,
            },
          };
        }
        if (method === "environmentRealizeWorkspace") {
          return {
            cwd: "/workspace/project",
            metadata: {
              realized: true,
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
            metadata: {
              commandId: "cmd-1",
            },
          };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Full Lifecycle",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "acme.environments",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Acme Environments",
        description: "Test plugin environment driver",
        author: "Acme",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: "fake-plugin",
            displayName: "Fake plugin",
            configSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const resumed = await runtimeWithPlugin.resumeRunLease({
      environment,
      lease: acquired.lease,
    });
    const realized = await runtimeWithPlugin.realizeWorkspace({
      environment,
      lease: acquired.lease,
      workspace: {
        localPath: "/tmp/project",
        mode: "ephemeral",
      },
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "echo",
      args: ["ok"],
      cwd: realized.cwd,
      env: { FOO: "bar" },
      stdin: "",
      timeoutMs: 1000,
    });
    const destroyed = await runtimeWithPlugin.destroyRunLease({
      environment,
      lease: acquired.lease,
    });

    expect(resumed).toMatchObject({
      providerLeaseId: "plugin-lease-full",
      metadata: {
        resumed: true,
      },
    });
    expect(realized).toEqual({
      cwd: "/workspace/project",
      metadata: {
        realized: true,
      },
    });
    expect(executed).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "ok\n",
    });
    expect(destroyed?.status).toBe("failed");
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentResumeLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: { template: "base" },
      providerLeaseId: "plugin-lease-full",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
      }),
    });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentRealizeWorkspace", expect.objectContaining({
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      config: { template: "base" },
      workspace: {
        localPath: "/tmp/project",
        mode: "ephemeral",
      },
    }));
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      command: "echo",
      args: ["ok"],
      cwd: "/workspace/project",
      env: { FOO: "bar" },
    }), 91000);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: { template: "base" },
      acquisitionId: acquired.lease.metadata?.acquisitionId,
      providerLeaseId: "plugin-lease-full",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
      }),
    });
  });

  it("releases with the driver captured on the lease even if the environment driver changes later", async () => {
    const { companyId, environment, runId } = await seedEnvironment();
    const environmentsSvc = environmentService(db);
    const localRelease = vi.fn(async ({ lease, status }: { lease: { id: string }; status: "released" | "expired" | "failed" }) =>
      await environmentsSvc.releaseLease(lease.id, status)
    );
    const sshRelease = vi.fn(async () => {
      throw new Error("ssh release should not be called");
    });
    const runtimeWithSpies = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async (input) => await environmentsSvc.acquireLease({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            issueId: input.issueId,
            heartbeatRunId: input.heartbeatRunId,
            metadata: {
              driver: input.environment.driver,
              executionWorkspaceMode: input.executionWorkspaceMode,
            },
          }),
          releaseRunLease: localRelease,
        },
        {
          driver: "ssh",
          acquireRunLease: async () => {
            throw new Error("ssh acquire should not be called");
          },
          releaseRunLease: sshRelease,
        },
      ],
    });

    const acquired = await runtimeWithSpies.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await environmentsSvc.update(environment.id, { driver: "ssh" });

    const released = await runtimeWithSpies.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(localRelease).toHaveBeenCalledTimes(1);
    expect(sshRelease).not.toHaveBeenCalled();
    expect(acquired.lease.metadata?.driver).toBe("local");
  });
});
