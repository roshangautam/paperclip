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
  buildCodexAcpConfig,
  createCodexAcpExecutor,
  nodeVersionMeetsCodexAcpMinimum,
  resolveCodexAcpBillingIdentity,
  resolveCodexExecutionEngine,
  resolveCodexExecutionEngineForRun,
  testCodexAcpEnvironment,
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
const originalPaperclipHome = process.env.PAPERCLIP_HOME;
const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

afterEach(async () => {
  prepareAdapterExecutionTargetRuntime.mockReset();
  setNodeVersion(originalNodeVersion);
  if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalPaperclipHome;
  if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
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
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
  process.env.PAPERCLIP_INSTANCE_ID = "test";
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
      name: "Codex ACP",
      adapterType: "codex_local",
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
      env: {
        CODEX_HOME: path.join(root, "codex-home"),
      },
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

async function buildSandboxInstructionsContext(
  root: string,
  restoreWorkspace: ReturnType<typeof vi.fn>,
): Promise<AdapterExecutionContext> {
  const workspaceDir = path.join(root, "workspace");
  const instructionsDir = path.join(root, "instructions");
  const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(instructionsDir, { recursive: true });
  await fs.writeFile(instructionsFilePath, "Use the staged instructions.\n", "utf8");

  prepareAdapterExecutionTargetRuntime.mockResolvedValue({
    target: {
      kind: "remote",
      transport: "sandbox",
      providerKey: "test-sandbox",
      remoteCwd: "/remote/workspace",
      syncWorkspace: false,
    },
    workspaceRemoteDir: "/remote/workspace",
    runtimeRootDir: "/remote/workspace/.paperclip-runtime/codex",
    assetDirs: {
      instructions: "/remote/workspace/.paperclip-runtime/codex/instructions",
    },
    restoreWorkspace,
  });

  return buildContext(workspaceDir, {
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
  });
}

describe("codex_local ACP lane", () => {
  it("defaults to ACP when prerequisites pass and falls back to CLI only for auto resolution", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-default-");
    const commandPath = path.join(root, "bin", "codex-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v22.13.0");

    expect(resolveCodexExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { engine: "cli", agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: true });
    expect(resolveCodexExecutionEngine({ engine: "acp" })).toEqual({
      engine: "acp",
      explicit: true,
    });

    setNodeVersion("v22.12.0");
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("Node"),
    });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { engine: "acp", agentCommand: "/missing/codex-acp" },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: true });
  });

  it("selects the confined CLI lane for local filesystem or network scope", async () => {
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("spawn-level confinement"),
    });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { engine: "acp", filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).rejects.toThrow("ACP confinement is not supported");
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { networkScope: "allowlist" },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("network scope"),
    });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { filesystemScope: "workpace" },
        executionTarget: null,
      }),
    ).rejects.toThrow('filesystemScope must be "workspace"');
  });

  it("uses ACP for bridged sandbox auto runs when the ACP command is configured as a shell command", async () => {
    setNodeVersion("v22.13.0");
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { agentCommand: "codex-acp" },
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
    setNodeVersion("v22.13.0");
    await expect(
      resolveCodexExecutionEngineForRun({
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
    setNodeVersion("v22.13.0");
    await expect(
      resolveCodexExecutionEngineForRun({
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

  it("maps Codex config to the ACPX Codex target", () => {
    expect(buildCodexAcpConfig({
      engine: "acp",
      cwd: "/repo",
      command: "codex",
      model: "gpt-5.5",
      modelReasoningEffort: "high",
      fastMode: true,
      agentCommand: "custom-codex-acp",
      warmHandleIdleMs: 25,
    })).toMatchObject({
      agent: "codex",
      cwd: "/repo",
      command: "codex",
      model: "gpt-5.5",
      modelReasoningEffort: "high",
      fastMode: true,
      agentCommand: "custom-codex-acp",
      mode: "persistent",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      warmHandleIdleMs: 25,
    });
  });

  it("checks the Node version required by the ACPX runtime", () => {
    setNodeVersion("v22.12.0");
    expect(nodeVersionMeetsCodexAcpMinimum()).toBe(false);
    setNodeVersion("v22.13.0");
    expect(nodeVersionMeetsCodexAcpMinimum()).toBe(true);
  });

  it("reports ACP prerequisites for the ACP lane", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-env-");
    const commandPath = path.join(root, "bin", "codex-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v22.13.0");

    const result = await testCodexAcpEnvironment({
      adapterType: "codex_local",
      companyId: "company-1",
      config: {
        engine: "acp",
        cwd: root,
        agentCommand: commandPath,
        env: { OPENAI_API_KEY: "test-key" },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_engine_selected",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_acp_command_resolvable",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_acp_runtime_scaffold",
        level: "info",
      }),
    );
  });

  it("executes through ACPX with Codex session config and ephemeral skills", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-exec-");
    const skill = await createRuntimeSkill(root);
    const runtimes: FakeRuntime[] = [];
    const meta: AdapterInvocationMeta[] = [];
    const execute = createCodexAcpExecutor({
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
        env: {
          CODEX_HOME: path.join(root, "codex-home"),
        },
        model: "gpt-5.5",
        modelReasoningEffort: "high",
        fastMode: true,
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
      agent: "codex",
      mode: "persistent",
      acpSessionId: "acp-1",
      workspaceId: "workspace-1",
    });
    expect(result.sessionParams?.skills).toMatchObject({
      mode: "codex",
      selectedSkills: ["review"],
    });
    const skillsHome = (result.sessionParams?.skills as { skillsHome?: string }).skillsHome;
    expect(skillsHome).toBeTruthy();
    await expect(fs.readFile(path.join(skillsHome!, "review", "SKILL.md"), "utf8")).resolves.toContain("review skill");
    expect(runtimes[0]?.ensureInputs[0]).toMatchObject({
      agent: "codex",
      mode: "persistent",
      cwd: root,
    });
    expect(runtimes[0]?.setConfigInputs).toEqual([]);
    expect(meta[0]?.commandNotes?.join("\n")).toContain("Prepared ACPX Codex skill home");
    expect(meta[0]?.env?.CODEX_HOME).toBe(path.join(root, "codex-home"));
    expect(JSON.parse(String(meta[0]?.env?.CODEX_CONFIG))).toEqual({
      model: "gpt-5.5",
      model_reasoning_effort: "high",
      service_tier: "fast",
      features: { fast_mode: true },
    });
  });

  it("stages the complete instruction bundle for sandbox ACP without synchronizing the workspace", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-instructions-");
    const workspaceDir = path.join(root, "workspace");
    const instructionsDir = path.join(root, "instructions");
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "workspace-only.txt"), "do not sync\n", "utf8");
    await fs.writeFile(instructionsFilePath, "Read SOUL.md and TOOLS.md.\n", "utf8");
    await fs.writeFile(path.join(instructionsDir, "SOUL.md"), "Be precise.\n", "utf8");
    await fs.writeFile(path.join(instructionsDir, "TOOLS.md"), "Use available tools.\n", "utf8");

    const restoreWorkspace = vi.fn(async () => undefined);
    let stagedFiles: string[] = [];
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => {
      const assets = input.assets ?? [];
      stagedFiles = await fs.readdir(assets[0]!.localDir);
      return {
        target: input.target,
        workspaceRemoteDir: "/remote/prepared-workspace",
        runtimeRootDir: "/remote/prepared-workspace/.paperclip-runtime/codex",
        assetDirs: {
          instructions: "/remote/prepared-workspace/.paperclip-runtime/codex/instructions",
        },
        restoreWorkspace,
      };
    });

    const runtimes: FakeRuntime[] = [];
    const execute = createCodexAcpExecutor({
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
    expect(stagedFiles.sort()).toEqual(["AGENTS.md", "SOUL.md", "TOOLS.md"]);
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const preparation = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0];
    expect(preparation?.target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      remoteCwd: "/remote/workspace",
      syncWorkspace: false,
    });
    expect(preparation?.assets).toEqual([{ key: "instructions", localDir: instructionsDir }]);
    expect(preparation?.assets).not.toContainEqual(expect.objectContaining({ key: "workspace" }));
    const prompt = runtimes[0]?.startInputs[0]?.text ?? "";
    expect(prompt).toContain(
      "The agent instructions for this session were loaded from /remote/prepared-workspace/.paperclip-runtime/codex/instructions/AGENTS.md.",
    );
    expect(prompt).toContain(
      "Resolve any relative file references from /remote/prepared-workspace/.paperclip-runtime/codex/instructions/.",
    );
    expect(prompt).not.toContain(instructionsDir);
    expect(runtimes[0]?.options.cwd).toBe("/remote/prepared-workspace");
    expect(result.sessionParams).toMatchObject({
      cwd: "/remote/workspace",
      remoteExecution: { remoteCwd: "/remote/workspace" },
    });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
  });

  it("stages the complete instruction bundle for SSH ACP", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-ssh-instructions-");
    const workspaceDir = path.join(root, "workspace");
    const instructionsDir = path.join(root, "instructions");
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(instructionsDir, { recursive: true });
    await fs.writeFile(instructionsFilePath, "Read SOUL.md.\n", "utf8");
    await fs.writeFile(path.join(instructionsDir, "SOUL.md"), "Be precise.\n", "utf8");

    const restoreWorkspace = vi.fn(async () => undefined);
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => ({
      target: input.target,
      workspaceRemoteDir: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace",
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace/.paperclip-runtime/codex",
      assetDirs: {
        instructions: "/remote/workspace/.paperclip-runtime/runs/run-1/workspace/.paperclip-runtime/codex/instructions",
      },
      restoreWorkspace,
    }));

    const runtimes: FakeRuntime[] = [];
    const execute = createCodexAcpExecutor({
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
        instructionsFilePath,
        instructionsRootPath: instructionsDir,
        instructionsEntryFile: "AGENTS.md",
        promptTemplate: "Do the assigned work.",
      },
      executionTarget: sshTarget,
    }));

    expect(result.exitCode).toBe(0);
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const preparation = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0];
    expect(preparation?.target).toEqual(sshTarget);
    expect(preparation?.assets).toEqual([{ key: "instructions", localDir: instructionsDir }]);
    const prompt = runtimes[0]?.startInputs[0]?.text ?? "";
    expect(prompt).toContain(
      "The agent instructions for this session were loaded from /remote/workspace/.paperclip-runtime/runs/run-1/workspace/.paperclip-runtime/codex/instructions/AGENTS.md.",
    );
    expect(prompt).toContain(
      "Resolve any relative file references from /remote/workspace/.paperclip-runtime/runs/run-1/workspace/.paperclip-runtime/codex/instructions/.",
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

  it("closes a prepared remote ACP handle before restoring its run-scoped workspace", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-remote-handle-");
    const lifecycle: string[] = [];
    const restoreWorkspace = vi.fn(async () => {
      lifecycle.push("restore");
    });
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => ({
      target: input.target,
      workspaceRemoteDir: "/remote/prepared-workspace",
      runtimeRootDir: "/remote/prepared-workspace/.paperclip-runtime/codex",
      assetDirs: {},
      restoreWorkspace,
    }));
    const runtimes: FakeRuntime[] = [];
    const execute = createCodexAcpExecutor({
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

  it("reuses the initialized ACPX executor across repeated calls", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-cached-executor-");
    const runtimes: FakeRuntime[] = [];
    let createRuntimeOptionReads = 0;
    const execute = createCodexAcpExecutor({
      get createRuntime() {
        createRuntimeOptionReads += 1;
        return (options: FakeRuntimeOptions) => {
          const runtime = new FakeRuntime(options);
          runtimes.push(runtime);
          return runtime as never;
        };
      },
    });

    const first = await execute(buildContext(root));
    await execute(buildContext(root, {
      runtime: {
        sessionId: first.sessionId ?? null,
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: first.sessionDisplayId ?? null,
        taskKey: "PAP-1",
      },
    }));

    expect(createRuntimeOptionReads).toBe(1);
    expect(runtimes).toHaveLength(2);
  });

  it("restores a sandbox after executor failure and preserves the executor result", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-executor-failure-");
    const restoreWorkspace = vi.fn(async () => undefined);
    const context = await buildSandboxInstructionsContext(root, restoreWorkspace);
    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(
        options,
        [],
        {
          status: "failed",
          error: { message: "executor failed before completion" },
        } as unknown as FakeRuntimeTurnResult,
      ) as never,
    });

    const result = await execute(context);

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: "executor failed before completion",
    });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
  });

  it("restores a sandbox when executor construction fails", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-construction-failure-");
    const restoreWorkspace = vi.fn(async () => undefined);
    const context = await buildSandboxInstructionsContext(root, restoreWorkspace);
    const execute = createCodexAcpExecutor({
      get createRuntime(): never {
        throw new Error("executor construction failed");
      },
    });

    await expect(execute(context)).rejects.toThrow("executor construction failed");
    expect(restoreWorkspace).toHaveBeenCalledOnce();
  });

  it("skips workspace restore after a remote bridge shutdown failure", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-bridge-shutdown-failure-");
    const restoreWorkspace = vi.fn(async () => undefined);
    const context = await buildSandboxInstructionsContext(root, restoreWorkspace);
    const bridgeShutdownError = Object.assign(
      new Error("ACP remote bridge shutdown failed"),
      { code: "acp_remote_bridge_shutdown_failed" },
    );
    const execute = createCodexAcpExecutor({
      createRuntime: () => {
        throw bridgeShutdownError;
      },
    });

    await expect(execute(context)).rejects.toMatchObject({
      code: "acp_workspace_restore_failed",
      cause: bridgeShutdownError,
    });
    expect(restoreWorkspace).not.toHaveBeenCalled();
  });

  it("returns sandbox restore failure after successful execution", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-restore-failure-");
    const restoreError = new Error("sandbox restore failed");
    const restoreWorkspace = vi.fn(async () => {
      throw restoreError;
    });
    const context = await buildSandboxInstructionsContext(root, restoreWorkspace);
    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });

    const result = await execute(context);

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

  it("preserves an executor failure when sandbox restore also fails", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-executor-and-restore-failure-");
    const restoreWorkspace = vi.fn(async () => {
      throw new Error("sandbox restore failed");
    });
    const context = await buildSandboxInstructionsContext(root, restoreWorkspace);
    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(
        options,
        [],
        {
          status: "failed",
          error: { message: "executor failed before completion" },
        } as unknown as FakeRuntimeTurnResult,
      ) as never,
    });

    const result = await execute(context);

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage:
        "executor failed before completion\nACP workspace restore failed: sandbox restore failed",
      errorCode: "acp_workspace_restore_failed",
      resultJson: {
        workspaceRestoreFailure: {
          code: "acp_workspace_restore_failed",
          message: "sandbox restore failed",
          executionError: {
            code: "acpx_turn_failed",
            message: "executor failed before completion",
          },
        },
      },
    });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
  });

  it("throws a coded restore failure when the executor and sandbox restore both throw", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-thrown-executor-and-restore-failure-");
    const restoreWorkspace = vi.fn(async () => {
      throw new Error("sandbox restore failed");
    });
    const context = await buildSandboxInstructionsContext(root, restoreWorkspace);
    const execute = createCodexAcpExecutor({
      createRuntime: () => {
        throw new Error("executor threw after workspace preparation");
      },
    });

    await expect(execute(context)).rejects.toMatchObject({
      code: "acp_workspace_restore_failed",
      message:
        "executor threw after workspace preparation\nACP workspace restore failed: sandbox restore failed",
    });
    expect(restoreWorkspace).toHaveBeenCalledOnce();
  });

  it("classifies ACP refresh-token auth failures", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-refresh-token-");
    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(
        options,
        [],
        {
          status: "failed",
          error: { message: "OAuth failed: refresh_token_invalidated" },
        } as unknown as FakeRuntimeTurnResult,
      ) as never,
    });

    const result = await execute(buildContext(root));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("refresh_token_invalidated");
    expect(result.errorFamily).toBe("refresh_token_invalidated");
    expect(result.resultJson?.errorFamily).toBe("refresh_token_invalidated");
    expect(result.resultJson).not.toHaveProperty("codexCredentialTelemetry");
  });

  it("resumes compatible ACP sessions on later Codex ACP runs", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-resume-");
    const runtimes: FakeRuntime[] = [];
    const execute = createCodexAcpExecutor({
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

describe("resolveCodexAcpBillingIdentity", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  });

  it("classifies an adapter-config API key as api billing to openai", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(
      resolveCodexAcpBillingIdentity({ config: { env: { OPENAI_API_KEY: "sk-test" } } }),
    ).toEqual({ provider: "openai", biller: "openai", billingType: "api" });
  });

  it("falls back to chatgpt subscription without an API key", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(resolveCodexAcpBillingIdentity({ config: {} })).toEqual({
      provider: "openai",
      biller: "chatgpt",
      billingType: "subscription",
    });
  });

  it("bills OpenRouter-backed runs to openrouter", () => {
    expect(
      resolveCodexAcpBillingIdentity({
        config: { env: { OPENAI_API_KEY: "sk-test", OPENROUTER_API_KEY: "or-test" } },
      }),
    ).toEqual({ provider: "openai", biller: "openrouter", billingType: "api" });
  });

  it("ignores host env for remote execution targets", () => {
    process.env.OPENAI_API_KEY = "sk-host-only";
    expect(
      resolveCodexAcpBillingIdentity({
        config: {},
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" },
      } as never).billingType,
    ).toBe("subscription");
  });
});
