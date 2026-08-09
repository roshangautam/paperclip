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
import { type PluginLoader, withPluginMutationLock } from "../services/plugin-loader.js";
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
      uninstallPlugin: vi.fn().mockImplementation(
        (plugin, removeData) => mockRegistry.uninstall(plugin.id, removeData),
      ) as PluginLoader["uninstallPlugin"],
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

  it("reconciles managed Apps after a successful plugin upgrade", async () => {
    const oldManifest = {
      id: "example.plugin",
      version: "1.0.0",
      capabilities: [],
    };
    const newManifest = {
      ...oldManifest,
      version: "1.1.0",
      tools: [{
        name: "new_tool",
        displayName: "New tool",
        description: "A tool added by the upgrade",
        parametersSchema: { type: "object", properties: {} },
      }],
    };
    currentPlugin = {
      ...basePlugin,
      manifestJson: oldManifest,
    } as PluginRecord;
    const upgradePlugin = vi.fn().mockImplementation(async (_pluginId, options) => {
      await options.beforePromote?.();
      return {
        oldManifest,
        newManifest,
        discovered: {
          version: "1.1.0",
        },
      };
    });
    const manager = lifecycle({
      upgradePlugin: upgradePlugin as PluginLoader["upgradePlugin"],
    });

    await expect(manager.upgrade("plugin-1", undefined, "/plugins/example")).resolves.toMatchObject({ status: "ready" });

    expect(upgradePlugin).toHaveBeenCalledWith("plugin-1", {
      version: undefined,
      localPath: "/plugins/example",
      beforePromote: expect.any(Function),
    });
    expect(reconcilePluginApplications).toHaveBeenCalledTimes(1);
  });

  it("keeps an upgraded plugin stopped until added capabilities are approved", async () => {
    const oldManifest = {
      id: "example.plugin",
      version: "1.0.0",
      capabilities: [],
    };
    const newManifest = {
      ...oldManifest,
      version: "1.1.0",
      capabilities: ["companies.read"],
    } as PluginRecord["manifestJson"];
    currentPlugin = { ...basePlugin, manifestJson: oldManifest } as PluginRecord;
    const loadSingle = vi.fn();
    const upgradePlugin = vi.fn().mockImplementation(async (_pluginId, options) => {
      await options.beforePromote?.();
      currentPlugin = { ...currentPlugin, version: newManifest.version, manifestJson: newManifest };
      return {
        oldManifest,
        newManifest,
        discovered: { version: newManifest.version },
      };
    });
    const manager = lifecycle({
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
      loadSingle: loadSingle as PluginLoader["loadSingle"],
      upgradePlugin: upgradePlugin as PluginLoader["upgradePlugin"],
    });

    await expect(manager.upgrade("plugin-1", "1.1.0")).resolves.toMatchObject({
      status: "upgrade_pending",
      version: "1.1.0",
      manifestJson: { capabilities: ["companies.read"] },
    });

    expect(loadSingle).not.toHaveBeenCalled();
    expect(reconcilePluginApplications).toHaveBeenCalledTimes(1);
  });

  it("keeps the current worker running when upgrade validation fails", async () => {
    const upgradePlugin = vi.fn().mockRejectedValue(new Error("invalid plugin manifest"));
    const stopWorker = vi.fn();
    const workerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      getWorker: vi.fn().mockReturnValue({}),
      stopWorker,
    } as unknown as PluginWorkerManager;
    const manager = lifecycle({
      upgradePlugin: upgradePlugin as PluginLoader["upgradePlugin"],
    }, workerManager);

    await expect(manager.upgrade("plugin-1", undefined, "/plugins/invalid"))
      .rejects.toThrow("invalid plugin manifest");

    expect(stopWorker).not.toHaveBeenCalled();
    expect(currentPlugin.status).toBe("ready");
  });

  it("serializes upgrade and unload through worker teardown and artifact cleanup", async () => {
    const oldManifest = {
      id: "example.plugin",
      version: "1.0.0",
      capabilities: [],
    };
    const newManifest = { ...oldManifest, version: "1.1.0" };
    let continueUpgrade!: () => void;
    const upgradeGate = new Promise<void>((resolve) => {
      continueUpgrade = resolve;
    });
    const upgradePlugin = vi.fn().mockImplementation(async (_pluginId, options) => {
      await upgradeGate;
      await options.beforePromote?.();
      return {
        oldManifest,
        newManifest,
        discovered: { version: "1.1.0" },
      };
    });
    let workerRunning = true;
    const unloadSingle = vi.fn().mockImplementation(async () => {
      workerRunning = false;
    });
    const loadSingle = vi.fn().mockImplementation(async () => {
      workerRunning = true;
      return {
        plugin: currentPlugin,
        success: true,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      };
    });
    const uninstallPlugin = vi.fn().mockImplementation(
      (plugin, removeData) => mockRegistry.uninstall(plugin.id, removeData),
    );
    const manager = lifecycle({
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      upgradePlugin: upgradePlugin as PluginLoader["upgradePlugin"],
      unloadSingle: unloadSingle as PluginLoader["unloadSingle"],
      loadSingle: loadSingle as PluginLoader["loadSingle"],
      uninstallPlugin: uninstallPlugin as PluginLoader["uninstallPlugin"],
    });

    const upgrade = manager.upgrade("plugin-1", undefined, "/plugins/example");
    await vi.waitFor(() => expect(upgradePlugin).toHaveBeenCalledOnce());
    const unload = manager.unload("plugin-1");

    await Promise.resolve();
    expect(uninstallPlugin).not.toHaveBeenCalled();

    continueUpgrade();
    await expect(upgrade).resolves.toMatchObject({ status: "ready" });
    await expect(unload).resolves.toMatchObject({ status: "uninstalled" });

    expect(unloadSingle).toHaveBeenCalledTimes(2);
    expect(loadSingle).toHaveBeenCalledOnce();
    expect(uninstallPlugin).toHaveBeenCalledOnce();
    expect(workerRunning).toBe(false);
    expect(currentPlugin.status).toBe("uninstalled");
  });

  it("does not unload during startup install activation", async () => {
    currentPlugin = { ...basePlugin, status: "installed" };
    let releaseActivation!: () => void;
    const holdActivation = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let markActivationStarted!: () => void;
    const activationStarted = new Promise<void>((resolve) => {
      markActivationStarted = resolve;
    });
    const loadSingle = vi.fn().mockImplementation(async () => {
      markActivationStarted();
      await holdActivation;
      return {
        plugin: currentPlugin,
        success: true,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      };
    });
    const uninstallPlugin = vi.fn().mockImplementation(
      (plugin, removeData) => mockRegistry.uninstall(plugin.id, removeData),
    );
    const manager = lifecycle({
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      loadSingle: loadSingle as PluginLoader["loadSingle"],
      uninstallPlugin: uninstallPlugin as PluginLoader["uninstallPlugin"],
    });
    const startupInstall = withPluginMutationLock(() => manager.load("plugin-1"));
    await activationStarted;
    const unload = manager.unload("plugin-1");

    await Promise.resolve();
    expect(uninstallPlugin).not.toHaveBeenCalled();

    releaseActivation();
    await expect(startupInstall).resolves.toMatchObject({ status: "ready" });
    await expect(unload).resolves.toMatchObject({ status: "uninstalled" });
    expect(loadSingle).toHaveBeenCalledOnce();
    expect(uninstallPlugin).toHaveBeenCalledOnce();
  });

  it("marks an activation failure as error without deadlocking the plugin lifecycle lock", async () => {
    currentPlugin = { ...basePlugin, status: "installed" };
    let manager!: ReturnType<typeof lifecycle>;
    const loadSingle = vi.fn().mockImplementation(async () => {
      await manager.markError("plugin-1", "Activation failed: worker startup failed");
      return {
        plugin: currentPlugin,
        success: false,
        error: "worker startup failed",
        registered: { worker: false, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      };
    });
    manager = lifecycle({
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      loadSingle: loadSingle as PluginLoader["loadSingle"],
    });

    let deadlockTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        manager.load("plugin-1"),
        new Promise<never>((_resolve, reject) => {
          deadlockTimer = setTimeout(() => reject(new Error("activation failure deadlocked")), 1_000);
        }),
      ])).rejects.toThrow("worker startup failed");
    } finally {
      if (deadlockTimer) clearTimeout(deadlockTimer);
    }

    expect(loadSingle).toHaveBeenCalledOnce();
    expect(currentPlugin).toMatchObject({
      status: "error",
      lastError: "Activation failed: worker startup failed",
    });
  });
});
