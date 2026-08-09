import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

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
    listInstalled: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
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
    await expect(second).rejects.toThrow("introduces new capabilities that require approval");
    expect(mocks.registry.update).toHaveBeenCalledOnce();
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
