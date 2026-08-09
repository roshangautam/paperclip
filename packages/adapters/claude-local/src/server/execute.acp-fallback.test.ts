import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn<() => Promise<AdapterExecutionResult>>(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  ACP_WORKSPACE_RESTORE_ERROR_CODE: "acp_workspace_restore_failed",
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: (reason: string) =>
    `[paperclip] Claude ACP default unavailable; falling back to Claude CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to Claude CLI when auto-selected ACP fails before execution starts", async () => {
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Claude ACP startup failed"),
    );
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining('Unexpected "<<"'),
    );
  });

  it("does not rerun through the CLI when ACP reports a workspace restore failure", async () => {
    executeClaudeAcp.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ACP workspace restore failed: sandbox restore failed",
      errorCode: "acp_workspace_restore_failed",
      resultJson: {
        workspaceRestoreFailure: {
          code: "acp_workspace_restore_failed",
          message: "sandbox restore failed",
        },
      },
    });
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "acp_workspace_restore_failed",
    });
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("does not rerun through the CLI when ACP throws a workspace restore failure", async () => {
    executeClaudeAcp.mockRejectedValueOnce(Object.assign(
      new Error("executor threw\nACP workspace restore failed: sandbox restore failed"),
      { code: "acp_workspace_restore_failed" },
    ));
    const ctx = buildContext();

    await expect(execute(ctx as never)).rejects.toMatchObject({
      code: "acp_workspace_restore_failed",
    });
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expect(ctx.onLog).not.toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("falling back to Claude CLI"),
    );
  });

  it("does not rerun through the CLI when ACP throws after remote bridge shutdown fails", async () => {
    executeClaudeAcp.mockRejectedValueOnce(Object.assign(
      new Error("ACP remote bridge shutdown failed after the turn completed"),
      { code: "acp_remote_bridge_shutdown_failed", remoteExecutionMayStillBeActive: false },
    ));
    const ctx = buildContext();

    await expect(execute(ctx as never)).rejects.toMatchObject({
      code: "acp_remote_bridge_shutdown_failed",
    });
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expect(ctx.onLog).not.toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("falling back to Claude CLI"),
    );
  });

  it("does not rerun through the CLI when ACP remote run cleanup fails", async () => {
    executeClaudeAcp.mockRejectedValueOnce(Object.assign(
      new Error("ACP execution failed and the restored remote run directory could not be removed"),
      { code: "acp_remote_run_cleanup_failed" },
    ));
    const ctx = buildContext();

    await expect(execute(ctx as never)).rejects.toMatchObject({
      code: "acp_remote_run_cleanup_failed",
    });
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    expect(ctx.onLog).not.toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("falling back to Claude CLI"),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
