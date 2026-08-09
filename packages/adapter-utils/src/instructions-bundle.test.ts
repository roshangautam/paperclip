import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveManagedInstructionsBundle } from "./instructions-bundle.js";

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("resolveManagedInstructionsBundle", () => {
  it("does not stage missing or non-directory instruction roots", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-instructions-bundle-"));
    roots.push(tempRoot);
    const fileRoot = path.join(tempRoot, "instructions-file");
    writeFileSync(fileRoot, "not a directory\n");

    for (const instructionsRootPath of [path.join(tempRoot, "missing"), fileRoot]) {
      expect(resolveManagedInstructionsBundle({
        instructionsRootPath,
        instructionsEntryFile: "AGENTS.md",
      })).toMatchObject({ rootPath: null, entryRelativePath: null });
    }
  });
});
