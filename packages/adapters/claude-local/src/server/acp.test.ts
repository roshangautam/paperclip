import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";

const { prepareAdapterExecutionTargetRuntime } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
  };
});
import {
  buildClaudeAcpConfig,
  createClaudeAcpExecutor,
  nodeVersionMeetsClaudeAcpMinimum,
  resolveClaudeAcpBillingIdentity,
  resolveClaudeExecutionEngine,
  resolveClaudeExecutionEngineForRun,
  testClaudeAcpEnvironment,
} from "./acp.js";

type FakeRuntimeOptions = Record<string, unknown>;
type FakeRuntimeEvent = { type: string; text?: string; stream?: string; tag?: string };
type FakeRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
};
type FakeRuntimeTurnResult = { status: "completed" | "failed" | "cancelled"; stopReason?: string };
type FakeRuntimeTurn = {
  requestId: string;
  events: AsyncIterable<FakeRuntimeEvent>;
  result: Promise<FakeRuntimeTurnResult>;
  cancel: () => Promise<void>;
  closeStream: () => Promise<void>;
};

const tempRoots: string[] = [];
const originalNodeVersion = process.version;

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

afterEach(async () => {
  prepareAdapterExecutionTargetRuntime.mockReset();
  vi.unstubAllEnvs();
  setNodeVersion(originalNodeVersion);
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

class FakeRuntime {
  ensureInputs: Array<{
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
  }> = [];
  startInputs: Array<{ handle: FakeRuntimeHandle; text: string; requestId: string; timeoutMs?: number }> = [];
  closeInputs: Array<{ handle: FakeRuntimeHandle; reason: string; discardPersistentState?: boolean }> = [];
  setConfigInputs: Array<{ handle: FakeRuntimeHandle; key: string; value: string }> = [];
  ensureCount = 0;

  constructor(
    readonly options: FakeRuntimeOptions,
    readonly events: FakeRuntimeEvent[] = [
      { type: "text_delta", text: "hello", stream: "output", tag: "agent_message_chunk" },
    ],
    readonly terminal: FakeRuntimeTurnResult = { status: "completed", stopReason: "end_turn" },
  ) {}

  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
  }): Promise<FakeRuntimeHandle> {
    this.ensureInputs.push(input);
    this.ensureCount += 1;
    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime-${this.ensureCount}`,
      cwd: input.cwd,
      acpxRecordId: `record-${this.ensureCount}`,
      backendSessionId: `acp-${this.ensureCount}`,
      agentSessionId: `agent-${this.ensureCount}`,
    };
  }

  startTurn(input: {
    handle: FakeRuntimeHandle;
    text: string;
    requestId: string;
    timeoutMs?: number;
  }): FakeRuntimeTurn {
    this.startInputs.push(input);
    const events = this.events;
    const terminal = this.terminal;
    return {
      requestId: input.requestId,
      events: {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) yield event;
        },
      },
      result: Promise.resolve(terminal),
      cancel: async () => {},
      closeStream: async () => {},
    };
  }

  runTurn(): AsyncIterable<FakeRuntimeEvent> {
    throw new Error("not used");
  }

  getCapabilities() {
    return { controls: [] };
  }

  getStatus() {
    return Promise.resolve({});
  }

  async setConfigOption(input: { handle: FakeRuntimeHandle; key: string; value: string }) {
    this.setConfigInputs.push(input);
  }

  async setMode() {}

  async cancel() {}

  async close(input: { handle: FakeRuntimeHandle; reason: string; discardPersistentState?: boolean }) {
    this.closeInputs.push(input);
  }
}

async function makeTempRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function createRuntimeSkill(root: string) {
  const source = path.join(root, "skills", "review");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\n---\nUse the review skill.\n", "utf8");
  return {
    key: "company/review",
    runtimeName: "review",
    source,
  };
}

function buildContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude ACP",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "PAP-1",
    },
    config: {
      engine: "acp",
      cwd: root,
      stateDir: path.join(root, "state"),
      promptTemplate: "Do the assigned work.",
    },
    context: {
      issueId: "issue-1",
      paperclipTaskMarkdown: "Task context",
      paperclipWorkspace: {
        cwd: root,
        source: "project_workspace",
        workspaceId: "workspace-1",
      },
    },
    onLog: async () => {},
    ...overrides,
  };
}

describe("claude_local ACP lane", () => {
  it("maps Claude config to the ACPX Claude target", () => {
    expect(buildClaudeAcpConfig({
      engine: "acp",
      cwd: "/repo",
      model: "claude-opus-4-7",
      effort: "high",
      agentCommand: "custom-claude-acp",
      warmHandleIdleMs: 25,
    })).toMatchObject({
      agent: "claude",
      cwd: "/repo",
      model: "claude-opus-4-7",
      effort: "high",
      agentCommand: "custom-claude-acp",
      mode: "persistent",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      warmHandleIdleMs: 25,
    });
  });

  it("checks the Node version required by the Claude ACP runtime", () => {
    setNodeVersion("v22.11.0");
    expect(nodeVersionMeetsClaudeAcpMinimum()).toBe(false);
    setNodeVersion("v22.12.0");
    expect(nodeVersionMeetsClaudeAcpMinimum()).toBe(true);
  });

  it("defaults to ACP when prerequisites pass and falls back to CLI only for auto resolution", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-default-");
    const commandPath = path.join(root, "bin", "claude-agent-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v22.12.0");

    expect(resolveClaudeExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "cli", agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: true });

    setNodeVersion("v22.11.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("Node"),
    });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", agentCommand: "/missing/claude-agent-acp" },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: true });
  });

  it("selects the confined CLI lane for local filesystem or network scope", async () => {
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("spawn-level confinement"),
    });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).rejects.toThrow("ACP confinement is not supported");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { networkScope: "deny" },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("network scope"),
    });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { networkScope: "public" },
        executionTarget: null,
      }),
    ).rejects.toThrow('networkScope must be "deny" or "allowlist"');
  });

  it("uses ACP for bridged sandbox auto runs when the ACP command is configured as a shell command", async () => {
    setNodeVersion("v22.12.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: "claude-agent-acp" },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: "/work",
          runner: {
            execute: async () => ({
              exitCode: 0,
              signal: null,
              timedOut: false,
              stdout: "",
              stderr: "",
              pid: null,
              startedAt: new Date().toISOString(),
            }),
          },
        },
      }),
    ).resolves.toEqual({ engine: "acp", explicit: false });
  });

  it("falls back to the CLI lane for one-shot sandbox auto runs", async () => {
    setNodeVersion("v22.12.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: {},
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: "/work",
        },
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("bidirectional remote process"),
    });
  });

  it("falls back to the CLI lane for non-sandbox remote auto runs", async () => {
    setNodeVersion("v22.12.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: {},
        executionTarget: {
          kind: "remote",
          transport: "ssh",
          remoteCwd: "/work",
          spec: {
            host: "127.0.0.1",
            port: 22,
            username: "fixture",
            remoteCwd: "/work",
            remoteWorkspacePath: "/work",
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("sandbox remote targets only"),
    });
  });

  it("reports ACP prerequisites for the ACP lane", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const root = await makeTempRoot("paperclip-claude-acp-env-");
    const commandPath = path.join(root, "bin", "claude-agent-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v22.12.0");

    const result = await testClaudeAcpEnvironment({
      adapterType: "claude_local",
      companyId: "company-1",
      config: {
        engine: "acp",
        cwd: root,
        agentCommand: commandPath,
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_engine_selected",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_acp_command_resolvable",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_acp_runtime_scaffold",
        level: "info",
      }),
    );
  });

  it("executes through ACPX with Claude model env, settings.local.json, and ephemeral skills", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-exec-");
    const skill = await createRuntimeSkill(root);
    const runtimes: FakeRuntime[] = [];
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(buildContext(root, {
      config: {
        engine: "acp",
        cwd: root,
        stateDir: path.join(root, "state"),
        model: "claude-opus-4-7",
        effort: "high",
        promptTemplate: "Do the assigned work.",
        paperclipRuntimeSkills: [skill],
        paperclipSkillSync: { desiredSkills: [skill.key] },
      },
      onMeta: async (payload: AdapterInvocationMeta) => {
        meta.push(payload);
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toMatchObject({
      agent: "claude",
      mode: "persistent",
      acpSessionId: "acp-1",
      workspaceId: "workspace-1",
    });
    expect(result.sessionParams?.skills).toMatchObject({
      mode: "claude",
      selectedSkills: ["review"],
    });
    const skillRoot = (result.sessionParams?.skills as { skillRoot?: string }).skillRoot;
    expect(skillRoot).toBeTruthy();
    await expect(fs.readFile(path.join(skillRoot!, "review", "SKILL.md"), "utf8")).resolves.toContain("review skill");
    expect(runtimes[0]?.setConfigInputs.map((input) => [input.key, input.value])).toEqual([["effort", "high"]]);
    expect(meta[0]?.commandNotes?.join("\n")).toContain("set via ANTHROPIC_MODEL");
    expect(meta[0]?.env?.ANTHROPIC_MODEL).toBe("claude-opus-4-7");
    const settings = JSON.parse(await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
    expect(settings.permissions.defaultMode).toBe("default");
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["Bash(curl:*)", "Bash(env)"]));
  });

  it("stages the complete instruction bundle for sandbox ACP without synchronizing the workspace", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-instructions-");
    const workspaceDir = path.join(root, "workspace");
    const instructionsDir = path.join(root, "instructions");
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(instructionsFilePath, "Read SOUL.md.\n", "utf8");
    await fs.writeFile(path.join(instructionsDir, "SOUL.md"), "Be precise.\n", "utf8");

    const restoreWorkspace = vi.fn(async () => undefined);
    let stagedFiles: string[] = [];
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => {
      stagedFiles = await fs.readdir(input.assets?.[0]?.localDir ?? "");
      return {
        target: input.target,
        workspaceRemoteDir: "/remote/prepared-workspace",
        runtimeRootDir: "/remote/prepared-workspace/.paperclip-runtime/claude",
        assetDirs: {
          instructions: "/remote/prepared-workspace/.paperclip-runtime/claude/instructions",
        },
        restoreWorkspace,
      };
    });

    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(buildContext(workspaceDir, {
      config: {
        engine: "acp",
        cwd: workspaceDir,
        stateDir: path.join(root, "state"),
        instructionsFilePath,
        instructionsRootPath: instructionsDir,
        instructionsEntryFile: "AGENTS.md",
        promptTemplate: "Do the assigned work.",
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test-sandbox",
        remoteCwd: "/remote/workspace",
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(stagedFiles.sort()).toEqual(["AGENTS.md", "SOUL.md"]);
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const preparation = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0];
    expect(preparation?.target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/remote/workspace",
      syncWorkspace: false,
    });
    expect(preparation?.assets).toEqual([{ key: "instructions", localDir: instructionsDir }]);
    const prompt = runtimes[0]?.startInputs[0]?.text ?? "";
    expect(prompt).toContain(
      "The above agent instructions were loaded from /remote/prepared-workspace/.paperclip-runtime/claude/instructions/AGENTS.md.",
    );
    expect(prompt).toContain(
      "Resolve any relative file references from /remote/prepared-workspace/.paperclip-runtime/claude/instructions/.",
    );
    expect(prompt).not.toContain(instructionsDir);
    expect(runtimes[0]?.options.cwd).toBe("/remote/prepared-workspace");
    expect(result.sessionParams).toMatchObject({
      cwd: "/remote/workspace",
      remoteExecution: { remoteCwd: "/remote/workspace" },
    });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
  });

  it("returns sandbox restore failure after successful execution", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-restore-failure-");
    const restoreWorkspace = vi.fn(async () => {
      throw new Error("sandbox restore failed");
    });
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => ({
      target: input.target,
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/claude",
      assetDirs: {},
      restoreWorkspace,
    }));
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });

    const result = await execute(buildContext(root, {
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test-sandbox",
        remoteCwd: "/remote/workspace",
      },
    }));

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: "ACP workspace restore failed: sandbox restore failed",
      errorCode: "acp_workspace_restore_failed",
      resultJson: {
        workspaceRestoreFailure: {
          code: "acp_workspace_restore_failed",
          message: "sandbox restore failed",
        },
      },
    });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
  });

  it("restores a sandbox when executor construction fails", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-construction-failure-");
    const restoreWorkspace = vi.fn(async () => undefined);
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => ({
      target: input.target,
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/claude",
      assetDirs: {},
      restoreWorkspace,
    }));
    const execute = createClaudeAcpExecutor({
      get createRuntime(): never {
        throw new Error("executor construction failed");
      },
    });

    await expect(execute(buildContext(root, {
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test-sandbox",
        remoteCwd: "/remote/workspace",
      },
    }))).rejects.toThrow("executor construction failed");
    expect(restoreWorkspace).toHaveBeenCalledOnce();
  });

  it("closes a prepared remote ACP handle before restoring its run-scoped workspace", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-remote-handle-");
    const lifecycle: string[] = [];
    const restoreWorkspace = vi.fn(async () => {
      lifecycle.push("restore");
    });
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => ({
      target: input.target,
      workspaceRemoteDir: "/remote/prepared-workspace",
      runtimeRootDir: "/remote/prepared-workspace/.paperclip-runtime/claude",
      assetDirs: {},
      restoreWorkspace,
    }));
    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        const close = runtime.close.bind(runtime);
        runtime.close = async (input) => {
          lifecycle.push("close");
          await close(input);
        };
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(buildContext(root, {
      config: {
        engine: "acp",
        cwd: root,
        stateDir: path.join(root, "state"),
        warmHandleIdleMs: 60_000,
        promptTemplate: "Do the assigned work.",
      },
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test-sandbox",
        remoteCwd: "/remote/workspace",
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(runtimes[0]?.closeInputs).toContainEqual(
      expect.objectContaining({ reason: "paperclip completed turn cleanup" }),
    );
    expect(lifecycle).toEqual(["close", "restore"]);
  });

  it("throws a coded restore failure when the executor and sandbox restore both throw", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-thrown-executor-and-restore-failure-");
    const restoreWorkspace = vi.fn(async () => {
      throw new Error("sandbox restore failed");
    });
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => ({
      target: input.target,
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/claude",
      assetDirs: {},
      restoreWorkspace,
    }));
    const execute = createClaudeAcpExecutor({
      createRuntime: () => {
        throw new Error("executor threw after workspace preparation");
      },
    });

    const execution = execute(buildContext(root, {
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        providerKey: "test-sandbox",
        remoteCwd: "/remote/workspace",
      },
    }));

    await expect(execution).rejects.toMatchObject({
      code: "acp_workspace_restore_failed",
      message:
        "executor threw after workspace preparation\nACP workspace restore failed: sandbox restore failed",
    });
    expect(restoreWorkspace).toHaveBeenCalledOnce();
  });

  it("executes SSH ACP in the prepared workspace while retaining the original session target", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-ssh-runtime-");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const restoreWorkspace = vi.fn(async () => undefined);
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => ({
      target: input.target,
      workspaceRemoteDir: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace/.paperclip-runtime/claude",
      assetDirs: {},
      restoreWorkspace,
    }));
    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });
    const sshTarget = {
      kind: "remote" as const,
      transport: "ssh" as const,
      remoteCwd: "/remote/workspace",
      spec: {
        host: "127.0.0.1",
        port: 22,
        username: "fixture",
        remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    };

    const result = await execute(buildContext(workspaceDir, {
      config: {
        engine: "acp",
        cwd: workspaceDir,
        stateDir: path.join(root, "state"),
        agentCommand: "claude-agent-acp",
      },
      executionTarget: sshTarget,
    }));

    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ target: sshTarget, assets: undefined }),
    );
    expect(runtimes[0]?.options.cwd).toBe(
      "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
    );
    expect(result.sessionParams).toMatchObject({
      cwd: "/remote/workspace",
      remoteExecution: { remoteCwd: "/remote/workspace" },
    });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
  });

  it("resumes compatible ACP sessions on later Claude ACP runs", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-resume-");
    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const first = await execute(buildContext(root));
    const second = await execute(buildContext(root, {
      runtime: {
        sessionId: first.sessionId ?? null,
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: first.sessionDisplayId ?? null,
        taskKey: "PAP-1",
      },
    }));

    expect(second.exitCode).toBe(0);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]?.ensureInputs[0]?.resumeSessionId).toBe("acp-1");
  });
});

describe("resolveClaudeAcpBillingIdentity", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  const originalBedrockBase = process.env.ANTHROPIC_BEDROCK_BASE_URL;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = originalBedrock;
    if (originalBedrockBase === undefined) delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    else process.env.ANTHROPIC_BEDROCK_BASE_URL = originalBedrockBase;
  });

  it("classifies an adapter-config API key as api billing", () => {
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { ANTHROPIC_API_KEY: "sk-ant-test" } } }),
    ).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
  });

  it("classifies Bedrock auth as metered_api billed to aws_bedrock", () => {
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } } }),
    ).toEqual({ provider: "anthropic", biller: "aws_bedrock", billingType: "metered_api" });
  });

  it("falls back to subscription without API-key or Bedrock auth", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    expect(resolveClaudeAcpBillingIdentity({ config: {} })).toEqual({
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription",
    });
  });

  it("ignores host env for remote execution targets", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-only";
    expect(
      resolveClaudeAcpBillingIdentity({
        config: {},
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" },
      } as never).billingType,
    ).toBe("subscription");
  });
});
