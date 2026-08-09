import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "", "");
      return { kill: vi.fn(), on: vi.fn() };
    },
  ),
  registry: {
    getById: vi.fn(),
    install: vi.fn(),
    listInstalled: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    uninstall: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mocks.registry,
}));

import { pluginLoader } from "../services/plugin-loader.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const cleanupPaths = new Set<string>();

function manifest(version: string): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.example",
    apiVersion: 1,
    version,
    displayName: "Example plugin",
    description: "Exercises consecutive npm plugin upgrades.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "./worker.js" },
  };
}

async function writeInstalledPackage(
  localPluginDir: string,
  packageName: string,
  pluginManifest: PaperclipPluginManifestV1,
): Promise<string> {
  const packageRoot = path.join(localPluginDir, "node_modules", packageName);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version: pluginManifest.version,
      type: "module",
      paperclipPlugin: { manifest: "./manifest.js" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "manifest.js"),
    `export default ${JSON.stringify(pluginManifest)};\n`,
    "utf8",
  );
  await writeFile(path.join(packageRoot, "worker.js"), "export {};\n", "utf8");
  return packageRoot;
}

describe("pluginLoader npm upgrades", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registry.listInstalled.mockResolvedValue([]);
  });

  afterEach(async () => {
    await Promise.all([...cleanupPaths].map((cleanupPath) => rm(cleanupPath, { recursive: true, force: true })));
    cleanupPaths.clear();
  });

  it("keeps consecutive version upgrades on the npm source", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-npm-upgrade-"));
    cleanupPaths.add(localPluginDir);
    const packageName = "paperclip-example";
    const packageRoot = await writeInstalledPackage(localPluginDir, packageName, manifest("1.1.0"));
    let currentPlugin = {
      id: "plugin-1",
      packageName,
      packagePath: null as string | null,
      manifestJson: manifest("1.0.0"),
    };
    mocks.registry.getById.mockImplementation(async () => currentPlugin);
    mocks.registry.update.mockImplementation(async (_pluginId, update) => {
      currentPlugin = {
        ...currentPlugin,
        packageName: update.packageName ?? currentPlugin.packageName,
        packagePath: update.packagePath === undefined ? currentPlugin.packagePath : update.packagePath,
        manifestJson: update.manifest ?? currentPlugin.manifestJson,
      };
      return currentPlugin;
    });
    const loader = pluginLoader({} as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.upgradePlugin("plugin-1", { version: "1.1.0" })).resolves.toMatchObject({
      discovered: { source: "npm", version: "1.1.0" },
    });
    expect(mocks.registry.update).toHaveBeenLastCalledWith(
      "plugin-1",
      expect.objectContaining({ packagePath: null, version: "1.1.0" }),
    );
    expect(currentPlugin.packagePath).toBeNull();

    const nextManifest = manifest("1.2.0");
    await writeFile(
      path.join(packageRoot, "manifest.js"),
      `export default ${JSON.stringify(nextManifest)};\n`,
      "utf8",
    );
    const future = new Date(Date.now() + 2_000);
    await utimes(path.join(packageRoot, "manifest.js"), future, future);

    await expect(loader.upgradePlugin("plugin-1", { version: "1.2.0" })).resolves.toMatchObject({
      discovered: { source: "npm", version: "1.2.0" },
    });
    expect(mocks.registry.update).toHaveBeenLastCalledWith(
      "plugin-1",
      expect.objectContaining({ packagePath: null, version: "1.2.0" }),
    );
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("checks queued upgrades against the manifest installed by the previous upgrade", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-npm-upgrade-"));
    cleanupPaths.add(localPluginDir);
    const packageName = "paperclip-example";
    const initialManifest = {
      ...manifest("1.0.0"),
      capabilities: ["agent.tools.register", "companies.read"] as PaperclipPluginManifestV1["capabilities"],
    };
    await writeInstalledPackage(localPluginDir, packageName, initialManifest);
    let currentPlugin = {
      id: "plugin-1",
      packageName,
      packagePath: null as string | null,
      manifestJson: initialManifest,
    };
    mocks.registry.getById.mockImplementation(async () => currentPlugin);
    mocks.registry.update.mockImplementation(async (_pluginId, update) => {
      currentPlugin = {
        ...currentPlugin,
        packageName: update.packageName ?? currentPlugin.packageName,
        packagePath: update.packagePath === undefined ? currentPlugin.packagePath : update.packagePath,
        manifestJson: update.manifest ?? currentPlugin.manifestJson,
      };
      return currentPlugin;
    });
    mocks.execFile.mockImplementation(
      (_file, args, _options, callback) => {
        const version = args[1]!.split("@").at(-1)!;
        const stagedPackageRoot = path.join(args[3]!, "node_modules", packageName);
        const candidate = {
          ...manifest(version),
          capabilities: version === "1.1.0"
            ? ["companies.read"]
            : ["companies.read", "agent.tools.register"],
        };
        void writeFile(
          path.join(stagedPackageRoot, "manifest.js"),
          `export default ${JSON.stringify(candidate)};\n`,
          "utf8",
        ).then(
          () => callback(null, "", ""),
          (error: Error) => callback(error, "", ""),
        );
        return { kill: vi.fn(), on: vi.fn() };
      },
    );

    const loader = pluginLoader({} as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReady!: () => void;
    const firstAtPromotion = new Promise<void>((resolve) => {
      firstReady = resolve;
    });

    const first = loader.upgradePlugin("plugin-1", {
      version: "1.1.0",
      beforePromote: async () => {
        firstReady();
        await holdFirst;
      },
    });
    await firstAtPromotion;
    const second = loader.upgradePlugin("plugin-1", { version: "1.2.0" });
    releaseFirst();

    await expect(first).resolves.toMatchObject({
      newManifest: { version: "1.1.0", capabilities: ["companies.read"] },
    });
    await expect(second).resolves.toMatchObject({
      oldManifest: { version: "1.1.0", capabilities: ["companies.read"] },
      newManifest: { version: "1.2.0", capabilities: ["companies.read", "agent.tools.register"] },
    });
    expect(mocks.registry.update).toHaveBeenCalledTimes(2);
  });

  it("restores the active npm package when registry persistence fails", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-npm-upgrade-"));
    cleanupPaths.add(localPluginDir);
    const packageName = "paperclip-example";
    const activeManifest = manifest("1.0.0");
    const packageRoot = await writeInstalledPackage(localPluginDir, packageName, activeManifest);
    await writeFile(path.join(packageRoot, "worker.js"), "export const marker = 'active';\n", "utf8");
    mocks.registry.getById.mockResolvedValue({
      id: "plugin-1",
      packageName,
      packagePath: null,
      manifestJson: activeManifest,
    });
    mocks.registry.update.mockRejectedValueOnce(new Error("registry persistence failed"));
    mocks.execFile.mockImplementationOnce((_file, args, _options, callback) => {
      const stagedInstallDir = args[3]!;
      void writeInstalledPackage(stagedInstallDir, packageName, manifest("1.1.0")).then(
        async (stagedPackageRoot) => {
          await writeFile(
            path.join(stagedPackageRoot, "worker.js"),
            "export const marker = 'replacement';\n",
            "utf8",
          );
          callback(null, "", "");
        },
        (error: Error) => callback(error, "", ""),
      );
      return { kill: vi.fn(), on: vi.fn() };
    });
    const loader = pluginLoader({} as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.upgradePlugin("plugin-1", { version: "1.1.0" }))
      .rejects.toThrow("registry persistence failed");

    await expect(readFile(path.join(packageRoot, "manifest.js"), "utf8"))
      .resolves.toBe(`export default ${JSON.stringify(activeManifest)};\n`);
    await expect(readFile(path.join(packageRoot, "worker.js"), "utf8"))
      .resolves.toBe("export const marker = 'active';\n");
  });

  it("keeps npm installs locked through registry persistence before an upgrade", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-npm-upgrade-"));
    cleanupPaths.add(localPluginDir);
    const existingPackageName = "paperclip-example";
    const installedPackageName = "paperclip-second";
    const existingManifest = manifest("1.0.0");
    const installedManifest = {
      ...manifest("1.0.0"),
      id: "paperclip.second",
      displayName: "Second plugin",
    };
    await writeInstalledPackage(localPluginDir, existingPackageName, existingManifest);

    let currentPlugin = {
      id: "plugin-1",
      packageName: existingPackageName,
      packagePath: null as string | null,
      manifestJson: existingManifest,
    };
    mocks.registry.getById.mockImplementation(async () => currentPlugin);
    mocks.registry.update.mockImplementation(async (_pluginId, update) => {
      currentPlugin = {
        ...currentPlugin,
        packageName: update.packageName ?? currentPlugin.packageName,
        packagePath: update.packagePath === undefined ? currentPlugin.packagePath : update.packagePath,
        manifestJson: update.manifest ?? currentPlugin.manifestJson,
      };
      return currentPlugin;
    });

    let markInstallPersistenceStarted!: () => void;
    const installPersistenceStarted = new Promise<void>((resolve) => {
      markInstallPersistenceStarted = resolve;
    });
    let releaseInstallPersistence!: () => void;
    const holdInstallPersistence = new Promise<void>((resolve) => {
      releaseInstallPersistence = resolve;
    });
    mocks.registry.install.mockImplementation(async () => {
      markInstallPersistenceStarted();
      await holdInstallPersistence;
      return { id: "plugin-2" };
    });
    mocks.execFile.mockImplementation((_file, args, _options, callback) => {
      const spec = args[1]!;
      const installDir = args[3]!;
      const packageName = spec.startsWith(`${existingPackageName}@`)
        ? existingPackageName
        : installedPackageName;
      const packageManifest = packageName === existingPackageName
        ? manifest("1.1.0")
        : installedManifest;
      void writeInstalledPackage(installDir, packageName, packageManifest).then(
        () => callback(null, "", ""),
        (error: Error) => callback(error, "", ""),
      );
      return { kill: vi.fn(), on: vi.fn() };
    });

    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    const loader = pluginLoader(db as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    const install = loader.installPlugin({ packageName: installedPackageName });
    await installPersistenceStarted;
    const upgrade = loader.upgradePlugin("plugin-1", { version: "1.1.0" });

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.registry.update).not.toHaveBeenCalled();

    releaseInstallPersistence();
    await expect(install).resolves.toMatchObject({
      packageName: installedPackageName,
      version: "1.0.0",
    });
    await expect(upgrade).resolves.toMatchObject({
      newManifest: { version: "1.1.0" },
    });

    expect(mocks.execFile.mock.calls.map((call) => call[1][1])).toEqual([
      installedPackageName,
      `${existingPackageName}@1.1.0`,
    ]);
    await expect(
      readFile(path.join(localPluginDir, "node_modules", installedPackageName, "worker.js"), "utf8"),
    ).resolves.toBe("export {};\n");
  });

  it("rejects a duplicate npm install without changing the live package", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-npm-upgrade-"));
    cleanupPaths.add(localPluginDir);
    const packageName = "paperclip-example";
    const activeManifest = manifest("1.0.0");
    const packageRoot = await writeInstalledPackage(localPluginDir, packageName, activeManifest);
    await writeFile(path.join(packageRoot, "worker.js"), "export const marker = 'active';\n", "utf8");

    mocks.registry.install.mockRejectedValueOnce(new Error(`Plugin already installed: ${activeManifest.id}`));
    mocks.execFile.mockImplementationOnce((_file, args, _options, callback) => {
      const stagedInstallDir = args[3]!;
      void writeInstalledPackage(stagedInstallDir, packageName, manifest("2.0.0")).then(
        async (stagedPackageRoot) => {
          await writeFile(
            path.join(stagedPackageRoot, "worker.js"),
            "export const marker = 'replacement';\n",
            "utf8",
          );
          callback(null, "", "");
        },
        (error: Error) => callback(error, "", ""),
      );
      return { kill: vi.fn(), on: vi.fn() };
    });

    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    const loader = pluginLoader(db as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.installPlugin({ packageName, version: "2.0.0" }))
      .rejects.toThrow(`Plugin already installed: ${activeManifest.id}`);

    expect(mocks.execFile.mock.calls[0]?.[1][3]).not.toBe(localPluginDir);
    await expect(readFile(path.join(packageRoot, "manifest.js"), "utf8"))
      .resolves.toBe(`export default ${JSON.stringify(activeManifest)};\n`);
    await expect(readFile(path.join(packageRoot, "worker.js"), "utf8"))
      .resolves.toBe("export const marker = 'active';\n");
  });

  it("does not resurrect a package cleaned up during another plugin upgrade", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-npm-upgrade-"));
    cleanupPaths.add(localPluginDir);
    const upgradedPackageName = "paperclip-example";
    const removedPackageName = "paperclip-removed";
    const activeManifest = manifest("1.0.0");
    await writeInstalledPackage(localPluginDir, upgradedPackageName, activeManifest);
    await writeInstalledPackage(localPluginDir, removedPackageName, {
      ...manifest("1.0.0"),
      id: "paperclip.removed",
      displayName: "Removed plugin",
    });
    await writeFile(
      path.join(localPluginDir, "package.json"),
      JSON.stringify({ dependencies: { [upgradedPackageName]: "1.0.0", [removedPackageName]: "1.0.0" } }),
      "utf8",
    );

    let currentPlugin = {
      id: "plugin-1",
      packageName: upgradedPackageName,
      packagePath: null as string | null,
      manifestJson: activeManifest,
    };
    mocks.registry.getById.mockImplementation(async () => currentPlugin);
    mocks.registry.update.mockImplementation(async (_pluginId, update) => {
      currentPlugin = {
        ...currentPlugin,
        packageName: update.packageName ?? currentPlugin.packageName,
        packagePath: update.packagePath === undefined ? currentPlugin.packagePath : update.packagePath,
        manifestJson: update.manifest ?? currentPlugin.manifestJson,
      };
      return currentPlugin;
    });
    mocks.execFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === "uninstall") {
        callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() };
      }
      const installDir = args[3]!;
      void writeInstalledPackage(installDir, upgradedPackageName, manifest("1.1.0")).then(
        () => callback(null, "", ""),
        (error: Error) => callback(error, "", ""),
      );
      return { kill: vi.fn(), on: vi.fn() };
    });

    const loader = pluginLoader({} as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });
    let markUpgradeReady!: () => void;
    const upgradeReady = new Promise<void>((resolve) => {
      markUpgradeReady = resolve;
    });
    let releaseUpgrade!: () => void;
    const holdUpgrade = new Promise<void>((resolve) => {
      releaseUpgrade = resolve;
    });
    const upgrade = loader.upgradePlugin("plugin-1", {
      version: "1.1.0",
      beforePromote: async () => {
        markUpgradeReady();
        await holdUpgrade;
      },
    });
    await upgradeReady;

    const cleanup = loader.cleanupInstallArtifacts({
      id: "plugin-2",
      pluginKey: "paperclip.removed",
      packageName: removedPackageName,
      packagePath: null,
    } as unknown as PluginRecord);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    releaseUpgrade();
    await expect(upgrade).resolves.toMatchObject({ newManifest: { version: "1.1.0" } });
    await expect(cleanup).resolves.toBeUndefined();

    expect(mocks.execFile.mock.calls.map((call) => call[1][0])).toEqual(["install", "uninstall"]);
    await expect(
      readFile(path.join(localPluginDir, "node_modules", upgradedPackageName, "manifest.js"), "utf8"),
    ).resolves.toBe(`export default ${JSON.stringify(manifest("1.1.0"))};\n`);
    await expect(
      readFile(path.join(localPluginDir, "node_modules", removedPackageName, "worker.js"), "utf8"),
    ).rejects.toThrow();
  });

  it("keeps uninstall atomic with a concurrent reinstall", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-npm-upgrade-"));
    cleanupPaths.add(localPluginDir);
    const packageName = "paperclip-example";
    const activeManifest = manifest("1.0.0");
    await writeInstalledPackage(localPluginDir, packageName, activeManifest);
    await writeFile(
      path.join(localPluginDir, "package.json"),
      JSON.stringify({ dependencies: { [packageName]: "1.0.0" } }),
      "utf8",
    );

    let releaseUninstall!: () => void;
    const holdUninstall = new Promise<void>((resolve) => {
      releaseUninstall = resolve;
    });
    let markUninstallStarted!: () => void;
    const uninstallStarted = new Promise<void>((resolve) => {
      markUninstallStarted = resolve;
    });
    mocks.registry.uninstall.mockImplementation(async () => {
      markUninstallStarted();
      await holdUninstall;
      return { id: "plugin-1", status: "uninstalled" };
    });
    mocks.registry.install.mockResolvedValue({ id: "plugin-1" });
    mocks.execFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === "uninstall") {
        callback(null, "", "");
      } else {
        void writeInstalledPackage(args[3]!, packageName, activeManifest).then(
          () => callback(null, "", ""),
          (error: Error) => callback(error, "", ""),
        );
      }
      return { kill: vi.fn(), on: vi.fn() };
    });

    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    const loader = pluginLoader(db as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });
    const plugin = {
      id: "plugin-1",
      pluginKey: activeManifest.id,
      packageName,
      packagePath: null,
    } as unknown as PluginRecord;

    const uninstall = loader.uninstallPlugin(plugin);
    await uninstallStarted;
    const reinstall = loader.installPlugin({ packageName });

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.registry.install).not.toHaveBeenCalled();

    releaseUninstall();
    await expect(uninstall).resolves.toMatchObject({ status: "uninstalled" });
    await expect(reinstall).resolves.toMatchObject({ packageName, version: "1.0.0" });
    expect(mocks.execFile.mock.calls.map((call) => call[1][0])).toEqual(["uninstall", "install"]);
    expect(mocks.registry.uninstall.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.registry.install.mock.invocationCallOrder[0]!);
  });

  it("rejects an npm replacement without changing active files or stopping its worker", async () => {
    const localPluginDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-npm-upgrade-"));
    cleanupPaths.add(localPluginDir);
    const packageName = "paperclip-example";
    const activeManifest = manifest("1.0.0");
    const packageRoot = await writeInstalledPackage(localPluginDir, packageName, activeManifest);
    await writeFile(path.join(packageRoot, "worker.js"), "export const marker = 'active';\n", "utf8");

    const currentPlugin = {
      id: "plugin-1",
      pluginKey: activeManifest.id,
      status: "ready",
      packageName,
      packagePath: null,
      version: activeManifest.version,
      manifestJson: activeManifest,
    };
    mocks.registry.getById.mockResolvedValue(currentPlugin);
    mocks.execFile.mockImplementationOnce(
      (_file, args, _options, callback) => {
        const stagedInstallDir = args[3]!;
        const stagedPackageRoot = path.join(stagedInstallDir, "node_modules", packageName);
        void Promise.all([
          writeFile(
            path.join(stagedPackageRoot, "manifest.js"),
            `export default ${JSON.stringify({ ...manifest("1.1.0"), id: "paperclip.other" })};\n`,
            "utf8",
          ),
          writeFile(path.join(stagedPackageRoot, "worker.js"), "export const marker = 'rejected';\n", "utf8"),
        ]).then(
          () => callback(null, "", ""),
          (error: Error) => callback(error, "", ""),
        );
        return { kill: vi.fn(), on: vi.fn() };
      },
    );

    const loader = pluginLoader({} as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });
    const stopWorker = vi.fn();
    const workerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      getWorker: vi.fn().mockReturnValue({}),
      stopWorker,
    } as unknown as PluginWorkerManager;
    const lifecycle = pluginLifecycleManager({} as never, { loader, workerManager });

    await expect(lifecycle.upgrade("plugin-1", "1.1.0"))
      .rejects.toThrow("does not match existing plugin ID");

    expect(await readFile(path.join(packageRoot, "manifest.js"), "utf8"))
      .toBe(`export default ${JSON.stringify(activeManifest)};\n`);
    expect(await readFile(path.join(packageRoot, "worker.js"), "utf8"))
      .toBe("export const marker = 'active';\n");
    expect(stopWorker).not.toHaveBeenCalled();
    expect(mocks.registry.update).not.toHaveBeenCalled();
  });
});
