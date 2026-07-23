import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  updateStatus: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const basePlugin = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: { id: "example.plugin", capabilities: [] },
  packageName: "@example/plugin",
  version: "1.0.0",
  packagePath: "/tmp/example-plugin",
} as PluginRecord;

describe("plugin lifecycle App reconciliation", () => {
  let currentPlugin: PluginRecord;
  let reconcilePluginApplications: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentPlugin = { ...basePlugin };
    reconcilePluginApplications = vi.fn().mockResolvedValue(undefined);
    mockRegistry.getById.mockImplementation(async () => currentPlugin);
    mockRegistry.updateStatus.mockImplementation(async (_pluginId, input) => {
      currentPlugin = { ...currentPlugin, ...input };
      return currentPlugin;
    });
    mockRegistry.uninstall.mockImplementation(async (_pluginId, removeData) => {
      if (removeData) return null;
      currentPlugin = { ...currentPlugin, status: "uninstalled" };
      return currentPlugin;
    });
  });

  function lifecycle(
    loaderOverrides: Partial<PluginLoader> = {},
    workerManager?: PluginWorkerManager,
  ) {
    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(false) as PluginLoader["hasRuntimeServices"],
      cleanupInstallArtifacts: vi.fn().mockResolvedValue(undefined) as PluginLoader["cleanupInstallArtifacts"],
      ...loaderOverrides,
    };
    return pluginLifecycleManager({} as never, {
      loader: loader as PluginLoader,
      workerManager,
      reconcilePluginApplications,
    });
  }

  it.each([
    ["disable", (manager: ReturnType<typeof lifecycle>) => manager.disable("plugin-1"), "disabled"],
    ["markError", (manager: ReturnType<typeof lifecycle>) => manager.markError("plugin-1", "worker exited"), "error"],
    ["markUpgradePending", (manager: ReturnType<typeof lifecycle>) => manager.markUpgradePending("plugin-1"), "upgrade_pending"],
    ["unload", (manager: ReturnType<typeof lifecycle>) => manager.unload("plugin-1"), "uninstalled"],
  ] as const)("reconciles immediately after %s", async (_name, action, expectedStatus) => {
    const manager = lifecycle();

    await action(manager);

    expect(currentPlugin.status).toBe(expectedStatus);
    expect(reconcilePluginApplications).toHaveBeenCalledTimes(1);
  });

  it("does not misreport a committed offline transition and retries reconciliation", async () => {
    vi.useFakeTimers();
    reconcilePluginApplications.mockRejectedValueOnce(new Error("managed App reconciliation failed"));
    const manager = lifecycle();
    const disabled = vi.fn();
    manager.on("plugin.disabled", disabled);

    try {
      await expect(manager.disable("plugin-1")).resolves.toMatchObject({ status: "disabled" });

      expect(currentPlugin.status).toBe("disabled");
      expect(disabled).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "plugin-1" }));
      expect(reconcilePluginApplications).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(reconcilePluginApplications).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a successfully activated plugin ready when reconciliation fails and retries", async () => {
    vi.useFakeTimers();
    currentPlugin = { ...basePlugin, status: "installed" };
    reconcilePluginApplications.mockRejectedValueOnce(new Error("managed App reconciliation failed"));
    const loadSingle = vi.fn().mockResolvedValue({
      plugin: basePlugin,
      success: true,
      registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 1 },
    });
    const stopWorker = vi.fn();
    const workerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      getWorker: vi.fn().mockReturnValue({}),
      stopWorker,
    } as unknown as PluginWorkerManager;
    const manager = lifecycle({
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      loadSingle: loadSingle as PluginLoader["loadSingle"],
    }, workerManager);
    const loaded = vi.fn();
    manager.on("plugin.loaded", loaded);

    try {
      await expect(manager.load("plugin-1")).resolves.toMatchObject({ status: "ready" });

      expect(loadSingle).toHaveBeenCalledWith("plugin-1");
      expect(currentPlugin.status).toBe("ready");
      expect(stopWorker).not.toHaveBeenCalled();
      expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "plugin-1" }));
      expect(reconcilePluginApplications).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(reconcilePluginApplications).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
