import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, buildClaudeProbePermissionArgs } from "./permissions.js";

const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

describe("claude-local remote permission args", () => {
  it("uses the canonical Bash tool grant for remote execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("allows only the runtime MCP servers attached to remote execution", () => {
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
      runtimeMcpServerNames: ["Plugin: Agent Identities", "Plugin: Agent Identities"],
    });

    expect(allowedTools.split(" ")).toContain("mcp__Plugin__Agent_Identities__*");
    expect(allowedTools.match(/mcp__/g)).toHaveLength(1);
    expect(allowedTools).not.toContain("mcp__*");
  });

  it("uses the canonical Bash tool grant for remote probes", () => {
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("does not use Bash(*) because Claude Code treats Bash grants as command-prefix patterns", () => {
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
    });

    expect(allowedTools.split(" ")).toContain("Bash");
    expect(allowedTools).not.toContain("Bash(*)");
  });

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
  });

  it("uses dangerously-skip-permissions for local execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("uses dangerously-skip-permissions for local probes", () => {
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });
});
