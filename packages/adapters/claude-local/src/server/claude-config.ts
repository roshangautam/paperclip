import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import {
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
  type AdapterExecutionTargetShellOptions,
} from "@paperclipai/adapter-utils/execution-target";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;

interface SeedFile {
  name: string;
  sourcePath: string;
  contents: Buffer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function sanitizeRemoteClaudeSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  settings.permissions = { defaultMode: "default" };
  delete settings.hooks;
  delete settings.mcpServers;
  delete settings.permissionMode;
  delete settings.skipDangerousModePermissionPrompt;
  return JSON.stringify(settings);
}

async function collectSeedFiles(sourceDir: string): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    const rawContents = await fs.readFile(sourcePath);
    const contents = name === "settings.json"
      ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
      : rawContents;
    files.push({ name, sourcePath, contents });
  }
  return files;
}

async function buildSeedSnapshotKey(files: SeedFile[]): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: SeedFile[];
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.writeFile(path.join(stagingDir, file.name), file.contents);
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export function resolveManagedClaudeRuntimeStateDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "claude-runtime");
}

export async function writePaperclipClaudeMcpConfig(input: {
  stateDir: string;
  runId: string;
  servers: AdapterRuntimeMcpServer[];
}): Promise<string> {
  const configDir = path.join(input.stateDir, "runs", input.runId, "mcp");
  const configPath = path.join(configDir, "mcp-config.json");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, buildPaperclipClaudeMcpConfig(input), { mode: 0o600 });
  return configPath;
}

export function resolveUniquePaperclipClaudeMcpServerNames(
  servers: AdapterRuntimeMcpServer[],
): string[] {
  const usedNames = new Set<string>();
  const names: string[] = [];
  for (const server of servers) {
    let name = server.name;
    if (usedNames.has(name)) name = `${name}-${server.connectionId.slice(0, 8)}`;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${server.name}-${server.connectionId.slice(0, 8)}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    names.push(name);
  }
  return names;
}

export function buildPaperclipClaudeMcpConfig(input: {
  servers: AdapterRuntimeMcpServer[];
  bridge?: { url: string; token: string };
}): string {
  const uniqueNames = resolveUniquePaperclipClaudeMcpServerNames(input.servers);
  const mcpServers: Record<string, unknown> = {};
  input.servers.forEach((server, index) => {
    const name = uniqueNames[index]!;
    const endpoint = input.bridge ? new URL(server.url) : null;
    mcpServers[name] = {
      type: "http",
      url: endpoint
        ? new URL(`${endpoint.pathname}${endpoint.search}`, `${input.bridge!.url.replace(/\/+$/, "")}/`).toString()
        : server.url,
      headers: input.bridge
        ? {
            Authorization: `Bearer ${input.bridge.token}`,
            "x-paperclip-tool-gateway-token": server.token,
          }
        : { Authorization: `Bearer ${server.token}` },
    };
  });
  return JSON.stringify({ mcpServers });
}

export async function materializeRemoteClaudeMcpConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  configPath: string;
  contents: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  const result = await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    `mkdir -p ${shellQuote(path.posix.dirname(input.configPath))} && ` +
      `printf '%s' "$PAPERCLIP_CLAUDE_MCP_CONFIG" > ${shellQuote(input.configPath)} && ` +
      `chmod 600 ${shellQuote(input.configPath)}`,
    {
      ...input.options,
      env: { ...input.options.env, PAPERCLIP_CLAUDE_MCP_CONFIG: input.contents },
    },
  );
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`Failed to write remote Claude MCP config${result.timedOut ? ": timed out" : `: exit ${result.exitCode ?? "unknown"}`}`);
  }
}

// The materialized remote MCP config embeds the callback-bridge bearer token and
// managed tool-gateway tokens. The managed workspace restore excludes
// .paperclip-runtime, so this file would otherwise persist readable on the
// remote resource after the run; attempt removal on both success and failure,
// and report cleanup failures without blocking bridge teardown or workspace restore.
export async function removeRemoteClaudeMcpConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  configPath: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  let result: Awaited<ReturnType<typeof runAdapterExecutionTargetShellCommand>>;
  try {
    result = await runAdapterExecutionTargetShellCommand(
      input.runId,
      input.target,
      `rm -f ${shellQuote(input.configPath)}`,
      input.options,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logPromise = input.options.onLog?.("stderr", `[paperclip] Failed to remove remote Claude MCP config: ${message}\n`);
    if (logPromise) await logPromise.catch(() => undefined);
    return;
  }
  if (result.timedOut || result.exitCode !== 0) {
    const reason = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "unknown"}`;
    const logPromise = input.options.onLog?.("stderr", `[paperclip] Failed to remove remote Claude MCP config: ${reason}\n`);
    if (logPromise) await logPromise.catch(() => undefined);
  }
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}

export function buildRemoteClaudeConfigMaterializationCommand(input: {
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
}): string {
  return `mkdir -p ${shellQuote(input.remoteClaudeConfigDir)} && ` +
    `if [ -d ${shellQuote(input.remoteClaudeConfigSeedDir)} ]; then ` +
    `cp -R ${shellQuote(`${input.remoteClaudeConfigSeedDir}/.`)} ${shellQuote(input.remoteClaudeConfigDir)}/; ` +
    `fi; ` +
    `for file in .credentials.json credentials.json; do ` +
    `if [ -n "\${HOME:-}" ] && [ -f "\${HOME}/.claude/\${file}" ] && [ ! -f ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}" ]; then ` +
    `cp "\${HOME}/.claude/\${file}" ${shellQuote(input.remoteClaudeConfigDir)}/"\${file}"; ` +
    `fi; ` +
    `done`;
}

export async function materializeRemoteClaudeConfig(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remoteClaudeConfigDir: string;
  remoteClaudeConfigSeedDir: string;
  options: AdapterExecutionTargetShellOptions;
}): Promise<void> {
  await runAdapterExecutionTargetShellCommand(
    input.runId,
    input.target,
    buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: input.remoteClaudeConfigDir,
      remoteClaudeConfigSeedDir: input.remoteClaudeConfigSeedDir,
    }),
    input.options,
  );
}
