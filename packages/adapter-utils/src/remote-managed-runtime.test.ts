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
const snapshotMocks = vi.hoisted(() => ({
  captureDirectorySnapshot: vi.fn(async () => ({ exclude: [], entries: new Map() })),
}));

vi.mock("./ssh.js", async () => {
  const actual = await vi.importActual<typeof import("./ssh.js")>("./ssh.js");
  return { ...actual, ...sshMocks };
});
vi.mock("./workspace-restore-merge.js", async () => {
  const actual = await vi.importActual<typeof import("./workspace-restore-merge.js")>(
    "./workspace-restore-merge.js",
  );
  return { ...actual, ...snapshotMocks };
});

import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  sshMocks.prepareWorkspaceForSshExecution.mockResolvedValue({ gitBacked: false });
  sshMocks.removeDirectoryFromSsh.mockResolvedValue(undefined);
  sshMocks.restoreWorkspaceFromSshExecution.mockResolvedValue(undefined);
  sshMocks.syncDirectoryToSsh.mockResolvedValue(undefined);
  snapshotMocks.captureDirectorySnapshot.mockResolvedValue({ exclude: [], entries: new Map() });
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

  it("cleans the run root without restoring when workspace preparation fails", async () => {
    const preparationError = new Error("upload failed");
    sshMocks.prepareWorkspaceForSshExecution.mockRejectedValueOnce(preparationError);

    await expect(prepareRuntime()).rejects.toBe(preparationError);

    expect(sshMocks.restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(sshMocks.removeDirectoryFromSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: "/remote/workspace/.paperclip-runtime/runs/run-1",
    }));
  });

  it("fails closed when preparation and run-root cleanup both fail", async () => {
    const preparationError = new Error("upload failed");
    sshMocks.prepareWorkspaceForSshExecution.mockRejectedValueOnce(preparationError);
    sshMocks.removeDirectoryFromSsh.mockRejectedValue(new Error("cleanup failed"));

    await expect(prepareRuntime()).rejects.toMatchObject({
      code: "acp_workspace_restore_failed",
      cause: preparationError,
      message: expect.stringContaining("cleanup failed"),
    });
    expect(sshMocks.restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  it("preserves the asset staging error when restore also fails", async () => {
    const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-"));
    const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-asset-"));
    tempDirs.push(localDir, assetDir);
    const stagingError = new Error("asset upload failed");
    sshMocks.syncDirectoryToSsh.mockRejectedValueOnce(stagingError);
    sshMocks.restoreWorkspaceFromSshExecution.mockRejectedValueOnce(new Error("restore failed"));

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
      runId: "run-1",
      adapterKey: "codex",
      workspaceLocalDir: localDir,
      assets: [{ key: "instructions", localDir: assetDir }],
    })).rejects.toMatchObject({
      code: "acp_workspace_restore_failed",
      cause: stagingError,
      message: expect.stringContaining("restore failed"),
    });
  });

  it("retries run-root deletion after a successful sync-back", async () => {
    const prepared = await prepareRuntime();
    sshMocks.removeDirectoryFromSsh.mockRejectedValueOnce(new Error("delete failed"));

    await expect(prepared.restoreWorkspace()).resolves.toBeUndefined();

    expect(sshMocks.restoreWorkspaceFromSshExecution).toHaveBeenCalledOnce();
    expect(sshMocks.removeDirectoryFromSsh).toHaveBeenCalledTimes(2);
  });

  it("surfaces exhausted run-root cleanup without invalidating sync-back", async () => {
    const prepared = await prepareRuntime();
    const progress = vi.fn(async () => undefined);
    sshMocks.removeDirectoryFromSsh.mockRejectedValue(new Error("delete failed"));

    await expect(prepared.restoreWorkspace(progress)).rejects.toMatchObject({
      code: "acp_remote_run_cleanup_failed",
      workspaceRestored: true,
      remoteRunDir: "/remote/workspace/.paperclip-runtime/runs/run-1",
    });

    expect(sshMocks.restoreWorkspaceFromSshExecution).toHaveBeenCalledOnce();
    expect(sshMocks.removeDirectoryFromSsh).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("delete failed"));
  });
});
