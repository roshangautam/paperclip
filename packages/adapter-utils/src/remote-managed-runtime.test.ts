import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sshMocks = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  removeDirectoryFromSsh: vi.fn(async () => undefined),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
}));

vi.mock("./ssh.js", async () => {
  const actual = await vi.importActual<typeof import("./ssh.js")>("./ssh.js");
  return { ...actual, ...sshMocks };
});

import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  sshMocks.restoreWorkspaceFromSshExecution.mockResolvedValue(undefined);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function prepareRuntime() {
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-"));
  tempDirs.push(localDir);
  return prepareRemoteManagedRuntime({
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
    runId: "run-1",
    adapterKey: "codex",
    workspaceLocalDir: localDir,
  });
}

describe("SSH remote managed runtime cleanup", () => {
  it("rejects run IDs that can escape the per-run root", async () => {
    await expect(prepareRemoteManagedRuntime({
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
      runId: "../outside",
      adapterKey: "codex",
      workspaceLocalDir: "/local/workspace",
    })).rejects.toThrow("runId must be a single safe path segment");

    expect(sshMocks.prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
  });

  it("removes the per-run root only after a successful restore", async () => {
    const prepared = await prepareRuntime();

    await prepared.restoreWorkspace();

    expect(sshMocks.restoreWorkspaceFromSshExecution).toHaveBeenCalledOnce();
    expect(sshMocks.removeDirectoryFromSsh).toHaveBeenCalledWith({
      spec: prepared.spec,
      remoteDir: "/remote/workspace/.paperclip-runtime/runs/run-1",
    });
    expect(
      sshMocks.restoreWorkspaceFromSshExecution.mock.invocationCallOrder[0],
    ).toBeLessThan(sshMocks.removeDirectoryFromSsh.mock.invocationCallOrder[0]!);
  });

  it("preserves the per-run root when restoration fails", async () => {
    const prepared = await prepareRuntime();
    sshMocks.restoreWorkspaceFromSshExecution.mockRejectedValueOnce(new Error("restore failed"));

    await expect(prepared.restoreWorkspace()).rejects.toThrow("restore failed");

    expect(sshMocks.removeDirectoryFromSsh).not.toHaveBeenCalled();
  });
});
