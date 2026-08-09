import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that reference them
// ---------------------------------------------------------------------------

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn());
const mockAdapterExecutionTargetToRemoteSpec = vi.hoisted(() => vi.fn());
const mockBuildWorkspaceRealizationRequest = vi.hoisted(() => vi.fn());
const mockUpdateLeaseMetadata = vi.hoisted(() => vi.fn());
const mockUpdateExecutionWorkspace = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
  resolveEnvironmentExecutionTransport: vi.fn().mockResolvedValue(null),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetToRemoteSpec: mockAdapterExecutionTargetToRemoteSpec,
}));

vi.mock("../services/workspace-realization.js", () => ({
  buildWorkspaceRealizationRequest: mockBuildWorkspaceRealizationRequest,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: vi.fn(() => ({
    ensureLocalEnvironment: vi.fn(),
    getById: vi.fn(),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    updateLeaseMetadata: mockUpdateLeaseMetadata,
  })),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: vi.fn(() => ({
    update: mockUpdateExecutionWorkspace,
  })),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  environmentRunOrchestrator,
  EnvironmentRunError,
} from "../services/environment-run-orchestrator.ts";
import type { Environment, EnvironmentLease, ExecutionWorkspace } from "@paperclipai/shared";
import type { RealizedExecutionWorkspace } from "../services/workspace-runtime.ts";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEnvironment(driver: string = "local"): Environment {
  return {
    id: "env-1",
    companyId: "company-1",
    name: "Test Environment",
    description: null,
    driver: driver as Environment["driver"],
    status: "active",
    config: {},
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "lease-1",
    companyId: "company-1",
    environmentId: "env-1",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: "run-1",
    status: "active",
    leasePolicy: "ephemeral",
    provider: "local",
    providerLeaseId: null,
    acquiredAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    reusableResourceOwner: false,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeExecutionWorkspace(cwd: string = "/workspace/project"): RealizedExecutionWorkspace {
  return {
    baseCwd: "/workspace",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "ws-1",
    repoUrl: null,
    repoRef: null,
    strategy: "project_primary",
    cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
  };
}

function makePersistedExecutionWorkspace(
  overrides: Partial<ExecutionWorkspace> = {},
): ExecutionWorkspace {
  return {
    id: "ew-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "standard",
    strategyType: "project_primary",
    name: "workspace",
    status: "open",
    cwd: "/workspace/project",
    repoUrl: null,
    baseRef: null,
    branchName: null,
    providerType: "local",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRealizeInput(overrides: {
  environment?: Environment;
  lease?: EnvironmentLease;
  persistedExecutionWorkspace?: ExecutionWorkspace | null;
  env?: Record<string, string>;
} = {}): Parameters<ReturnType<typeof environmentRunOrchestrator>["realizeForRun"]>[0] {
  return {
    environment: overrides.environment ?? makeEnvironment("local"),
    lease: overrides.lease ?? makeLease(),
    adapterType: "claude_local",
    companyId: "company-1",
    issueId: null,
    heartbeatRunId: "run-1",
    executionWorkspace: makeExecutionWorkspace(),
    effectiveExecutionWorkspaceMode: null,
    persistedExecutionWorkspace: overrides.persistedExecutionWorkspace !== undefined
      ? overrides.persistedExecutionWorkspace
      : null,
    env: overrides.env,
  };
}

function makeMockRuntime(overrides: Partial<EnvironmentRuntimeService> = {}): EnvironmentRuntimeService {
  return {
    acquireRunLease: vi.fn(),
    releaseRunLeases: vi.fn(),
    execute: vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }),
    realizeWorkspace: vi.fn().mockResolvedValue({
      cwd: "/workspace/project",
      metadata: {
        workspaceRealization: {
          version: 1,
          driver: "local",
          cwd: "/workspace/project",
        },
      },
    }),
    ...overrides,
  } as unknown as EnvironmentRuntimeService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("environmentRunOrchestrator — realizeForRun", () => {
  const mockDb = {} as any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: null,
      },
    });

    mockAdapterExecutionTargetToRemoteSpec.mockReturnValue({
      kind: "local",
      environmentId: "env-1",
      leaseId: "lease-1",
    });

    mockUpdateLeaseMetadata.mockResolvedValue(null);
    mockUpdateExecutionWorkspace.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("happy path: returns lease, executionTarget, and remoteExecution on successful realization", async () => {
    const executionTarget = { kind: "local", environmentId: "env-1", leaseId: "lease-1" };
    const remoteExecution = { kind: "local", environmentId: "env-1", leaseId: "lease-1" };

    mockResolveEnvironmentExecutionTarget.mockResolvedValue(executionTarget);
    mockAdapterExecutionTargetToRemoteSpec.mockReturnValue(remoteExecution);

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput());

    expect(result.lease).toBeDefined();
    expect(result.executionTarget).toEqual(executionTarget);
    expect(result.remoteExecution).toEqual(remoteExecution);
    expect(result.workspaceRealization).toEqual(
      expect.objectContaining({ version: 1, driver: "local" }),
    );

    expect(runtime.realizeWorkspace).toHaveBeenCalledOnce();
    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledOnce();
  });

  it("realization failure: runtime.realizeWorkspace throws → EnvironmentRunError with code workspace_realization_failed", async () => {
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockRejectedValue(new Error("sandbox unreachable")),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput())).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "workspace_realization_failed" &&
        err.environmentId === "env-1" &&
        err.driver === "local",
    );

    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });

  it("forwards transient realization env without persisting its secrets", async () => {
    const appCredentials = {
      GITHUB_APP_ID: "12345",
      GITHUB_INSTALLATION_ID: "67890",
      GITHUB_APP_PRIVATE_KEY: "transient-private-key",
      GITHUB_APP_PRIVATE_KEY_FILE: "/host/github-app.pem",
    };
    const persistedExecutionWorkspace = makePersistedExecutionWorkspace();
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/workspace/project",
        metadata: {
          workspaceRealization: {
            rebuild: {
              repoUrl: `https://${appCredentials.GITHUB_APP_ID}@github.com/example/project.git`,
              installationId: appCredentials.GITHUB_INSTALLATION_ID,
              authEcho: appCredentials.GITHUB_APP_PRIVATE_KEY,
              keyFileEcho: appCredentials.GITHUB_APP_PRIVATE_KEY_FILE,
              [appCredentials.GITHUB_APP_PRIVATE_KEY]: "credential in a metadata key",
            },
          },
        },
      }),
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("plugin" as Environment["driver"]),
      persistedExecutionWorkspace,
      env: appCredentials,
    }));

    expect(runtime.realizeWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      env: appCredentials,
    }));
    expect(result.workspaceRealization).toEqual({
      rebuild: {
        repoUrl: "https://12345@github.com/example/project.git",
        installationId: "67890",
        authEcho: "***REDACTED***",
        keyFileEcho: "***REDACTED***",
        "***REDACTED***": "credential in a metadata key",
      },
    });
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledWith(
      "lease-1",
      expect.objectContaining({
        remoteCwd: "/workspace/project",
        workspaceRealization: result.workspaceRealization,
      }),
    );
    expect(mockUpdateExecutionWorkspace).toHaveBeenCalledWith(
      "ew-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspaceRealization: result.workspaceRealization,
        }),
      }),
    );
    const persistedValues = JSON.stringify([
      mockUpdateLeaseMetadata.mock.calls,
      mockUpdateExecutionWorkspace.mock.calls,
    ]);
    for (const value of [
      appCredentials.GITHUB_APP_PRIVATE_KEY,
      appCredentials.GITHUB_APP_PRIVATE_KEY_FILE,
    ]) {
      expect(persistedValues).not.toContain(value);
    }
    expect(persistedValues).toContain(appCredentials.GITHUB_APP_ID);
    expect(persistedValues).toContain(appCredentials.GITHUB_INSTALLATION_ID);
  });

  it("allows non-secret GitHub App identifiers in a realization cwd", async () => {
    const appId = "12345";
    const installationId = "67890";
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: `/workspace/${appId}/${installationId}/project`,
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("plugin" as Environment["driver"]),
      env: {
        GITHUB_APP_ID: appId,
        GITHUB_INSTALLATION_ID: installationId,
      },
    }));

    expect(result.workspaceRealization).toEqual({});
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledWith(
      "lease-1",
      expect.objectContaining({ remoteCwd: `/workspace/${appId}/${installationId}/project` }),
    );
    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledOnce();
  });

  it("rejects a realization cwd containing secret transient values", async () => {
    const token = "github_pat_transient_path_token";
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: `/workspace/${token}/project`,
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput({
      env: { GITHUB_TOKEN: token },
    }))).rejects.toMatchObject({
      code: "workspace_realization_failed",
      message: expect.stringContaining("GITHUB_TOKEN"),
    });

    expect(mockUpdateLeaseMetadata).not.toHaveBeenCalled();
    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });

  it("rejects a realization cwd containing a JSON-escaped multiline transient value", async () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\ntransient-key-material\n-----END PRIVATE KEY-----";
    const escapedPrivateKey = JSON.stringify(privateKey).slice(1, -1);
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: `/workspace/${escapedPrivateKey}/project`,
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput({
      env: { GITHUB_APP_PRIVATE_KEY: privateKey },
    }))).rejects.toMatchObject({
      code: "workspace_realization_failed",
      message: expect.stringContaining("GITHUB_APP_PRIVATE_KEY"),
    });

    expect(mockUpdateLeaseMetadata).not.toHaveBeenCalled();
    expect(mockResolveEnvironmentExecutionTarget).not.toHaveBeenCalled();
  });

  it("does not invoke or persist non-data realization metadata properties", async () => {
    const token = "github_pat_metadata_descriptor_token";
    const metadata = {} as Record<PropertyKey, unknown>;
    const getter = vi.fn(() => token);
    Object.defineProperty(metadata, `accessor-${token}`, {
      enumerable: true,
      get: getter,
    });
    Object.defineProperty(metadata, `hidden-${token}`, {
      enumerable: false,
      value: token,
    });
    metadata[Symbol(token)] = token;
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/workspace/project",
        metadata: { workspaceRealization: metadata },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput({
      env: { GITHUB_TOKEN: token },
    }));

    expect(getter).not.toHaveBeenCalled();
    expect(result.workspaceRealization).toEqual({});
    expect(JSON.stringify(mockUpdateLeaseMetadata.mock.calls)).not.toContain(token);
  });

  it("redacts transient realization env from provider errors, including circular details", async () => {
    const token = "github_pat_transient_failure_token";
    const providerError = new Error(`clone failed for ${token}`) as Error & {
      details?: Record<string, unknown>;
      self?: unknown;
    };
    providerError.details = { stderr: `authorization: Bearer ${token}` };
    providerError.self = providerError;
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockRejectedValue(providerError),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    let thrown: unknown;
    try {
      await orchestrator.realizeForRun(makeRealizeInput({ env: { GITHUB_TOKEN: token } }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvironmentRunError);
    expect(thrown).toMatchObject({
      code: "workspace_realization_failed",
      cause: expect.objectContaining({
        message: "clone failed for ***REDACTED***",
        details: { stderr: "authorization: Bearer ***REDACTED***" },
        self: "[Circular]",
      }),
    });
    expect(String((thrown as Error).message)).not.toContain(token);
    expect(JSON.stringify((thrown as EnvironmentRunError).cause)).not.toContain(token);
  });

  it("redacts JSON-escaped multiline transient values from provider output", async () => {
    const privateKey = "-----BEGIN PRIVATE KEY-----\ntransient-key-material\n-----END PRIVATE KEY-----";
    const serializedSecret = JSON.stringify({ privateKey });
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/workspace/project",
        metadata: {
          workspaceRealization: { providerOutput: serializedSecret },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput({
      env: { GITHUB_APP_PRIVATE_KEY: privateKey },
    }));

    expect(result.workspaceRealization).toEqual({
      providerOutput: '{"privateKey":"***REDACTED***"}',
    });
    expect(JSON.stringify(mockUpdateLeaseMetadata.mock.calls)).not.toContain(
      JSON.stringify(privateKey).slice(1, -1),
    );
  });

  it("target resolution failure: resolveEnvironmentExecutionTarget throws → EnvironmentRunError with code transport_resolution_failed", async () => {
    mockResolveEnvironmentExecutionTarget.mockRejectedValue(new Error("network error"));

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput())).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "transport_resolution_failed" &&
        err.environmentId === "env-1",
    );
  });

  it("defers core-synced plugin provisioning to the execution target", async () => {
    const environment = makeEnvironment("plugin" as Environment["driver"]);
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "paperclip.coder-sandbox-provider:coder",
      remoteCwd: "/home/coder/workspace",
    };

    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: "pnpm install",
      },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(executionTarget);

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/home/coder/workspace",
        metadata: {
          workspaceRealization: {
            version: 1,
            transport: "plugin",
            remote: { path: "/home/coder/workspace" },
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(
      makeRealizeInput({ environment }),
    );

    expect(runtime.realizeWorkspace).toHaveBeenCalledOnce();
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledWith(
      "lease-1",
      expect.objectContaining({ remoteCwd: "/home/coder/workspace" }),
    );
    expect(result.workspaceRealization).toEqual({
      version: 1,
      transport: "plugin",
      remote: { path: "/home/coder/workspace" },
    });
    expect(result.executionTarget).toEqual({
      ...executionTarget,
      provisionCommand: "pnpm install",
    });
  });

  it("persists a plugin cwd when realization metadata is omitted", async () => {
    const environment = makeEnvironment("plugin" as Environment["driver"]);
    const updatedLease = makeLease({ metadata: { remoteCwd: "/home/coder/workspace" } });
    mockUpdateLeaseMetadata.mockResolvedValue(updatedLease);
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({ cwd: "/home/coder/workspace" }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput({ environment }));

    expect(mockUpdateLeaseMetadata).toHaveBeenCalledWith(
      "lease-1",
      expect.objectContaining({ remoteCwd: "/home/coder/workspace" }),
    );
    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: updatedLease,
        leaseMetadata: expect.objectContaining({ remoteCwd: "/home/coder/workspace" }),
      }),
    );
    expect(result.workspaceRealization).toEqual({});
  });

  it("uses the provider cwd when the optional realization hook is absent", async () => {
    const environment = makeEnvironment("plugin" as Environment["driver"]);
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      ...mockBuildWorkspaceRealizationRequest(),
      runtimeOverlay: { provisionCommand: "pnpm install" },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({ cwd: "" }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment,
      lease: makeLease({
        metadata: {
          providerMetadata: { remoteCwd: "/home/coder/workspace" },
        },
      }),
    }));

    expect(runtime.realizeWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      workspace: expect.objectContaining({ remotePath: "/home/coder/workspace" }),
    }));
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "bash",
      args: ["-lc", "pnpm install"],
      cwd: "/home/coder/workspace",
      workspaceRealization: {},
    }));
  });

  it("uses the configured plugin cwd when realization and lease metadata omit it", async () => {
    const environment = {
      ...makeEnvironment("plugin" as Environment["driver"]),
      config: { driverConfig: { remoteCwd: "/home/coder/configured-workspace" } },
    };
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      ...mockBuildWorkspaceRealizationRequest(),
      runtimeOverlay: { provisionCommand: "pnpm install" },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({ cwd: "" }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({ environment }));

    expect(runtime.realizeWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      workspace: expect.objectContaining({ remotePath: "/home/coder/configured-workspace" }),
    }));
    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/home/coder/configured-workspace",
    }));
  });

  it("refuses plugin provisioning without a remote cwd", async () => {
    const environment = makeEnvironment("plugin" as Environment["driver"]);
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      ...mockBuildWorkspaceRealizationRequest(),
      runtimeOverlay: { provisionCommand: "pnpm install" },
    });
    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({ cwd: "" }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput({ environment }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "workspace_realization_failed" &&
        err.message.includes("requires a remote working directory"),
    );
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("persisted metadata is updated on lease and execution workspace after realization", async () => {
    const persistedExecutionWorkspace = makePersistedExecutionWorkspace();
    const updatedLease = makeLease({
      metadata: { workspaceRealization: { version: 1, driver: "local", cwd: "/workspace/project" } },
    });
    const updatedEw = { ...persistedExecutionWorkspace, metadata: { workspaceRealizationRequest: {}, workspaceRealization: {} } };

    mockUpdateLeaseMetadata.mockResolvedValue(updatedLease);
    mockUpdateExecutionWorkspace.mockResolvedValue(updatedEw);
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({ kind: "local", environmentId: "env-1", leaseId: "lease-1" });

    const runtime = makeMockRuntime();
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(
      makeRealizeInput({ persistedExecutionWorkspace }),
    );

    // Lease metadata should have been updated with workspaceRealization
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledOnce();
    expect(mockUpdateLeaseMetadata).toHaveBeenCalledWith(
      "lease-1",
      expect.objectContaining({ workspaceRealization: expect.any(Object) }),
    );

    // Execution workspace metadata should have been updated
    expect(mockUpdateExecutionWorkspace).toHaveBeenCalledOnce();
    expect(mockUpdateExecutionWorkspace).toHaveBeenCalledWith(
      "ew-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspaceRealizationRequest: expect.any(Object),
          workspaceRealization: expect.any(Object),
        }),
      }),
    );

    // The returned lease should reflect the updated value
    expect(result.lease).toEqual(updatedLease);
    expect(result.persistedExecutionWorkspace).toEqual(updatedEw);
  });

  it("defers sandbox provisioning when the adapter manages workspace sync", async () => {
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: "npm install -g @anthropic-ai/claude-code",
      },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      remoteCwd: "/remote/workspace",
      environmentId: "env-1",
      leaseId: "lease-1",
    });

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/remote/workspace",
        metadata: {
          workspaceRealization: {
            version: 1,
            transport: "sandbox",
            remote: { path: "/remote/workspace" },
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    const result = await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("sandbox"),
    }));

    expect(runtime.execute).not.toHaveBeenCalled();
    expect(result.executionTarget).toMatchObject({
      provisionCommand: "npm install -g @anthropic-ai/claude-code",
    });
  });

  it("runs project-level provision commands for ssh environments", async () => {
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "gemini_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: "npm install -g @google/gemini-cli",
      },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/remote/workspace",
      environmentId: "env-1",
      leaseId: "lease-1",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    });

    const runtime = makeMockRuntime({
      realizeWorkspace: vi.fn().mockResolvedValue({
        cwd: "/remote/workspace",
        metadata: {
          workspaceRealization: {
            version: 1,
            transport: "ssh",
            remote: { path: "/remote/workspace" },
          },
        },
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("ssh"),
      lease: makeLease({
        provider: "ssh",
        metadata: {
          driver: "ssh",
          remoteCwd: "/remote/workspace",
          remoteWorkspacePath: "/remote/workspace",
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
        },
      }),
    }));

    expect(runtime.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "bash",
      args: ["-lc", "npm install -g @google/gemini-cli"],
    }));
    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledOnce();
  });

  it("surfaces provider-defined provision command failures", async () => {
    const token = "github_pat_transient_provision_token";
    mockBuildWorkspaceRealizationRequest.mockReturnValue({
      version: 1,
      adapterType: "claude_local",
      companyId: "company-1",
      environmentId: "env-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace/project",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: "install-tool",
      },
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue({
      kind: "remote",
      transport: "sandbox",
      providerKey: "e2b",
      remoteCwd: "/remote/workspace",
      syncWorkspace: false,
    });

    const runtime = makeMockRuntime({
      execute: vi.fn().mockResolvedValue({
        exitCode: 127,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: `/bin/sh: install-tool failed with ${token}\n`,
      }),
    });
    const orchestrator = environmentRunOrchestrator(mockDb, { environmentRuntime: runtime });

    await expect(orchestrator.realizeForRun(makeRealizeInput({
      environment: makeEnvironment("sandbox"),
      env: { GITHUB_TOKEN: token },
    }))).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EnvironmentRunError &&
        err.code === "workspace_realization_failed" &&
        String(err.message).includes("install-tool failed with ***REDACTED***") &&
        !String(err.message).includes(token) &&
        !JSON.stringify(err.cause).includes(token),
    );

    expect(mockResolveEnvironmentExecutionTarget).toHaveBeenCalledOnce();
  });
});
