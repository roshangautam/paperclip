import { describe, expect, it, vi } from "vitest";
import {
  ACP_REMOTE_BRIDGE_SHUTDOWN_ERROR_CODE,
  stopPaperclipBridgeThenRestoreWorkspace,
  type AdapterExecutionTargetPaperclipBridgeHandle,
} from "./execution-target.js";

function bridgeShutdownError(remoteExecutionMayStillBeActive: boolean): Error {
  return Object.assign(new Error("Sandbox callback bridge shutdown failed"), {
    code: ACP_REMOTE_BRIDGE_SHUTDOWN_ERROR_CODE,
    remoteExecutionMayStillBeActive,
  });
}

function bridgeThatRejects(error: Error): AdapterExecutionTargetPaperclipBridgeHandle {
  return {
    env: {},
    stop: vi.fn(async () => {
      throw error;
    }),
  };
}

describe("stopPaperclipBridgeThenRestoreWorkspace", () => {
  it("stops the bridge before restoring the workspace", async () => {
    const events: string[] = [];
    const paperclipBridge: AdapterExecutionTargetPaperclipBridgeHandle = {
      env: {},
      stop: vi.fn(async () => {
        events.push("stop");
      }),
    };

    await stopPaperclipBridgeThenRestoreWorkspace({
      paperclipBridge,
      beforeRestore: async () => {
        events.push("beforeRestore");
      },
      restoreRemoteWorkspace: async () => {
        events.push("restore");
      },
    });

    expect(events).toEqual(["stop", "beforeRestore", "restore"]);
  });

  it("restores the workspace before surfacing a cleanup-only bridge failure", async () => {
    const cleanupError = bridgeShutdownError(false);
    const restoreRemoteWorkspace = vi.fn(async () => undefined);
    const beforeRestore = vi.fn(async () => undefined);

    await expect(stopPaperclipBridgeThenRestoreWorkspace({
      paperclipBridge: bridgeThatRejects(cleanupError),
      restoreRemoteWorkspace,
      beforeRestore,
    })).rejects.toBe(cleanupError);

    expect(beforeRestore).toHaveBeenCalledTimes(1);
    expect(restoreRemoteWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not sync back while remote execution may still be active", async () => {
    const shutdownError = bridgeShutdownError(true);
    const restoreRemoteWorkspace = vi.fn(async () => undefined);

    await expect(stopPaperclipBridgeThenRestoreWorkspace({
      paperclipBridge: bridgeThatRejects(shutdownError),
      restoreRemoteWorkspace,
    })).rejects.toBe(shutdownError);

    expect(restoreRemoteWorkspace).not.toHaveBeenCalled();
  });

  it("does not sync back after an unclassified bridge stop failure", async () => {
    const shutdownError = new Error("Unexpected bridge stop failure");
    const restoreRemoteWorkspace = vi.fn(async () => undefined);

    await expect(stopPaperclipBridgeThenRestoreWorkspace({
      paperclipBridge: bridgeThatRejects(shutdownError),
      restoreRemoteWorkspace,
    })).rejects.toBe(shutdownError);

    expect(restoreRemoteWorkspace).not.toHaveBeenCalled();
  });
});
