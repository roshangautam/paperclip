import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
  },
}));

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mocks.registry,
}));

import { pluginLoader } from "../services/plugin-loader.js";

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
});
