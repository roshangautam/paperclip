import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetShellCommand } = vi.hoisted(() => ({
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target");
  return {
    ...actual,
    runAdapterExecutionTargetShellCommand,
  };
});

import {
  buildPaperclipClaudeMcpConfig,
  prepareClaudeConfigSeed,
  removeRemoteClaudeMcpConfig,
  resolveUniquePaperclipClaudeMcpServerNames,
} from "./claude-config.js";
import { buildClaudeExecutionPermissionArgs } from "./permissions.js";


describe("removeRemoteClaudeMcpConfig", () => {
  it("reports a nonzero remote cleanup command without throwing", async () => {
    runAdapterExecutionTargetShellCommand.mockResolvedValueOnce({
      exitCode: 255,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "permission denied",
      pid: null,
      startedAt: new Date().toISOString(),
    });
    const onLog = vi.fn(async () => {});

    const failure = await removeRemoteClaudeMcpConfig({
      runId: "run-1",
      target: null,
      configPath: "/remote/.paperclip-runtime/claude/mcp-config/runs/run-1/mcp-config.json",
      options: {
        cwd: "/remote/workspace",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
        onLog,
      },
    });

    expect(failure).toMatchObject({ message: "Failed to remove remote Claude MCP config: exit 255" });
    expect(onLog).toHaveBeenCalledWith(
      "stderr",
      "[paperclip] Failed to remove remote Claude MCP config: exit 255\n",
    );
  });
});

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    runAdapterExecutionTargetShellCommand.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    });
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("resolveUniquePaperclipClaudeMcpServerNames", () => {
  const servers = [
    { name: "Plugin: Agent Identities", url: "https://a.invalid/mcp", token: "t1", connectionId: "1111aaaa2222" },
    { name: "Plugin: Agent Identities", url: "https://b.invalid/mcp", token: "t2", connectionId: "3333bbbb4444" },
    { name: "Plugin: Agent Identities", url: "https://c.invalid/mcp", token: "t3", connectionId: "5555cccc6666" },
  ];

  it("aligns MCP config keys with remote --allowedTools grants for duplicate server names", () => {
    const uniqueNames = resolveUniquePaperclipClaudeMcpServerNames(servers);
    expect(new Set(uniqueNames).size).toBe(servers.length);

    const config = JSON.parse(
      buildPaperclipClaudeMcpConfig({ servers, bridge: { url: "https://bridge.invalid", token: "bridge-token" } }),
    );
    const configKeys = Object.keys(config.mcpServers);
    expect(configKeys).toEqual(uniqueNames);

    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
      runtimeMcpServerNames: uniqueNames,
    });
    const grantedPatterns = new Set(allowedTools.split(" "));
    for (const key of configKeys) {
      const pattern = `mcp__${key.replace(/[^a-zA-Z0-9_-]/g, "_")}__*`;
      expect(grantedPatterns.has(pattern)).toBe(true);
    }
    expect(allowedTools.match(/mcp__/g)).toHaveLength(servers.length);
  });
});
