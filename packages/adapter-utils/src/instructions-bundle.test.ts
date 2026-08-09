import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("stages an existing entry inside the instruction root", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-instructions-bundle-"));
    roots.push(tempRoot);
    const nestedRoot = path.join(tempRoot, "nested");
    const filePath = path.join(nestedRoot, "AGENTS.md");
    mkdirSync(nestedRoot);
    writeFileSync(filePath, "Use the managed instructions.\n");

    expect(resolveManagedInstructionsBundle({
      instructionsRootPath: tempRoot,
      instructionsEntryFile: path.join("nested", "AGENTS.md"),
    })).toEqual({
      filePath,
      rootPath: tempRoot,
      entryRelativePath: "nested/AGENTS.md",
    });
  });

  it.each([
    ["missing entry", "MISSING.md"],
    ["directory entry", "."],
    ["parent traversal", path.join("..", "AGENTS.md")],
  ])("does not stage a %s", (_name, instructionsEntryFile) => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-instructions-bundle-"));
    roots.push(tempRoot);

    expect(resolveManagedInstructionsBundle({
      instructionsRootPath: tempRoot,
      instructionsEntryFile,
    })).toMatchObject({ rootPath: null, entryRelativePath: null });
  });
});
