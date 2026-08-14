import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";

describe("plugin execution workspace bridge", () => {
  it("routes metadata reads through the host client when the capability is declared", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: null,
      path: "/tmp/workspace-1",
      cwd: "/tmp/workspace-1",
      repoUrl: null,
      baseRef: "main",
      branchName: "feature/workspace-1",
      providerType: "git_worktree",
      providerMetadata: null,
    });
    const handlers = createHostClientHandlers({
      pluginId: "workspace-plugin",
      capabilities: ["execution.workspaces.read"],
      services: {
        executionWorkspaces: { get },
      } as any,
    });

    await expect(
      handlers["executionWorkspaces.get"](
        { workspaceId: "workspace-1", companyId: "company-1" },
        { invocationScope: { companyId: "company-1" } },
      ),
    ).resolves.toMatchObject({
      id: "workspace-1",
      cwd: "/tmp/workspace-1",
    });
    expect(get).toHaveBeenCalledWith({ workspaceId: "workspace-1", companyId: "company-1" });
  });

  it("rejects metadata reads when the plugin lacks execution.workspace read access", async () => {
    const get = vi.fn();
    const handlers = createHostClientHandlers({
      pluginId: "workspace-plugin",
      capabilities: [],
      services: {
        executionWorkspaces: { get },
      } as any,
    });

    await expect(
      handlers["executionWorkspaces.get"](
        { workspaceId: "workspace-1", companyId: "company-1" },
        { invocationScope: { companyId: "company-1" } },
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("routes command execution only for the matching run-bound invocation scope", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      stdout: "ok",
      stderr: "",
    });
    const handlers = createHostClientHandlers({
      pluginId: "workspace-plugin",
      capabilities: ["execution.workspaces.execute"],
      services: { executionWorkspaces: { execute } } as any,
    });
    const params = {
      workspaceId: "workspace-1",
      companyId: "company-1",
      runId: "run-1",
      command: "git",
      args: ["status"],
    };

    await expect(
      handlers["executionWorkspaces.execute"](params, {
        invocationScope: { companyId: "company-1", runId: "run-1", agentId: "agent-1" },
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    await expect(
      handlers["executionWorkspaces.execute"](params, {
        invocationScope: { companyId: "company-2", runId: "run-1", agentId: "agent-1" },
      }),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an absent invocation scope", undefined],
    ["an expired invocation scope", { invalidInvocationScope: true }],
    [
      "a different invocation run",
      { invocationScope: { companyId: "company-1", runId: "run-2", agentId: "agent-1" } },
    ],
  ])("rejects command execution with %s", async (_case, context) => {
    const execute = vi.fn();
    const handlers = createHostClientHandlers({
      pluginId: "workspace-plugin",
      capabilities: ["execution.workspaces.execute"],
      services: { executionWorkspaces: { execute } } as any,
    });

    await expect(
      handlers["executionWorkspaces.execute"](
        {
          workspaceId: "workspace-1",
          companyId: "company-1",
          runId: "run-1",
          command: "git",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects command execution when the target run belongs to another agent", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("Heartbeat run is not owned by the invoking agent"));
    const handlers = createHostClientHandlers({
      pluginId: "workspace-plugin",
      capabilities: ["execution.workspaces.execute"],
      services: { executionWorkspaces: { execute } } as any,
    });
    const context = {
      invocationScope: { companyId: "company-1", runId: "run-1", agentId: "agent-1" },
    };

    await expect(
      handlers["executionWorkspaces.execute"](
        {
          workspaceId: "workspace-1",
          companyId: "company-1",
          runId: "run-1",
          command: "git",
        },
        context,
      ),
    ).rejects.toThrow("Heartbeat run is not owned by the invoking agent");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), context);
  });

  it("rejects command execution without execution workspace execute access", async () => {
    const execute = vi.fn();
    const handlers = createHostClientHandlers({
      pluginId: "workspace-plugin",
      capabilities: [],
      services: { executionWorkspaces: { execute } } as any,
    });

    await expect(
      handlers["executionWorkspaces.execute"](
        { workspaceId: "workspace-1", companyId: "company-1", runId: "run-1", command: "git" },
        { invocationScope: { companyId: "company-1", runId: "run-1", agentId: "agent-1" } },
      ),
    ).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
    expect(execute).not.toHaveBeenCalled();
  });
});
