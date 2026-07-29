import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const packages = [
  {
    directory: "packages/adapter-utils",
    bundledPath: "package/node_modules/acpx/dist/runtime.js",
    bundledManifestPath: "package/node_modules/acpx/package.json",
    markers: ['metaRaw.origin === "assistant"', 'metaRaw.kind === "model"'],
  },
  {
    directory: "packages/adapters/claude-local",
    bundledPath:
      "package/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js",
    bundledManifestPath:
      "package/node_modules/@agentclientprotocol/claude-agent-acp/package.json",
    markers: ['modelOutput: true', 'origin: "assistant", kind: "model"'],
  },
  {
    directory: "packages/adapters/codex-local",
    bundledPath: "package/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
    bundledManifestPath: "package/node_modules/@agentclientprotocol/codex-acp/package.json",
    markers: [
      'return { ...createAgentTextMessageChunk(text), _meta: { origin: "assistant", kind: "model" } };',
      '...(!entered ? { _meta: { origin: "assistant", kind: "model" } } : {})',
    ],
  },
  {
    directory: "packages/adapters/gemini-local",
    bundledPath: "package/node_modules/@google/gemini-cli/bundle/gemini-7M47OEXS.js",
    bundledManifestPath: "package/node_modules/@google/gemini-cli/package.json",
    markers: ['_meta: { origin: "assistant", kind: "model" }'],
  },
] as const;

describe("published ACPX provenance artifacts", () => {
  const packRoot = mkdtempSync(path.join(tmpdir(), "paperclip-acpx-pack-"));
  const tarballs = new Map<string, string>();

  beforeAll(() => {
    for (const { directory } of packages) {
      execFileSync("pnpm", ["--dir", directory, "build"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      const output = execFileSync(
        "pnpm",
        [
          "--silent",
          "--config.node-linker=hoisted",
          "--dir",
          directory,
          "pack",
          "--json",
          "--pack-destination",
          packRoot,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      const metadata = JSON.parse(output) as { filename: string };
      tarballs.set(directory, metadata.filename);
    }
  }, 120_000);

  afterAll(async () => {
    await rm(packRoot, { force: true, recursive: true });
  });

  it("retains the patched dependencies in each package", () => {
    for (const { directory, bundledPath, markers } of packages) {
      const tarball = tarballs.get(directory);
      expect(tarball).toBeDefined();
      const source = execFileSync("tar", ["-xOf", tarball!, bundledPath], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      for (const marker of markers) expect(source).toContain(marker);
    }
  });

  it("declares every bundled runtime dependency at the package level", () => {
    for (const { directory, bundledManifestPath } of packages) {
      const tarball = tarballs.get(directory);
      expect(tarball).toBeDefined();
      const readManifest = (entry: string) =>
        JSON.parse(execFileSync("tar", ["-xOf", tarball!, entry], { encoding: "utf8" })) as {
          dependencies?: Record<string, string>;
        };
      const packageManifest = readManifest("package/package.json");
      const runtimeManifest = readManifest(bundledManifestPath);

      for (const dependency of Object.keys(runtimeManifest.dependencies ?? {})) {
        expect(packageManifest.dependencies, `${directory} must install ${dependency}`).toHaveProperty(
          dependency,
        );
      }
    }
  });
});
