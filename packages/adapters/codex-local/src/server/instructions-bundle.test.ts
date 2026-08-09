import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexInstructionsBundle } from "./instructions-bundle.js";

describe("resolveCodexInstructionsBundle", () => {
  const rootPath = path.resolve("paperclip-codex-instructions");
  const outsidePath = path.resolve(rootPath, "..", "outside", "AGENTS.md");

  it("resolves a valid nested entry relative to the instruction root", () => {
    const filePath = path.join(rootPath, "nested", "AGENTS.md");

    expect(resolveCodexInstructionsBundle({
      instructionsFilePath: filePath,
      instructionsRootPath: rootPath,
      instructionsEntryFile: path.join("nested", "AGENTS.md"),
    })).toEqual({
      filePath,
      rootPath,
      entryRelativePath: "nested/AGENTS.md",
    });
  });

  it("derives the instruction file path from the root and entry", () => {
    expect(resolveCodexInstructionsBundle({
      instructionsRootPath: rootPath,
      instructionsEntryFile: path.join("nested", "AGENTS.md"),
    })).toEqual({
      filePath: path.join(rootPath, "nested", "AGENTS.md"),
      rootPath,
      entryRelativePath: "nested/AGENTS.md",
    });
  });

  it("derives the entry from an instruction file path inside the root", () => {
    const filePath = path.join(rootPath, "nested", "AGENTS.md");

    expect(resolveCodexInstructionsBundle({
      instructionsFilePath: filePath,
      instructionsRootPath: rootPath,
    })).toEqual({
      filePath,
      rootPath,
      entryRelativePath: "nested/AGENTS.md",
    });
  });

  it("uses the configured file as the staged entry when the entry setting differs", () => {
    const filePath = path.join(rootPath, "AGENTS.md");

    expect(resolveCodexInstructionsBundle({
      instructionsFilePath: filePath,
      instructionsRootPath: rootPath,
      instructionsEntryFile: path.join("nested", "AGENTS.md"),
    })).toEqual({
      filePath,
      rootPath,
      entryRelativePath: "AGENTS.md",
    });
  });

  it.each([
    {
      name: "missing root",
      config: { instructionsFilePath: path.join(rootPath, "AGENTS.md") },
      filePath: path.join(rootPath, "AGENTS.md"),
    },
    {
      name: "missing file and entry",
      config: { instructionsRootPath: rootPath },
      filePath: "",
    },
  ])("disables bundle staging for $name", ({ config, filePath }) => {
    expect(resolveCodexInstructionsBundle(config)).toEqual({
      filePath,
      rootPath: null,
      entryRelativePath: null,
    });
  });

  it.each([
    ["parent traversal", { instructionsEntryFile: path.join("..", "AGENTS.md") }, path.resolve(rootPath, "..", "AGENTS.md")],
    ["absolute entry", { instructionsEntryFile: outsidePath }, outsidePath],
    ["file outside root", { instructionsFilePath: outsidePath }, outsidePath],
    ["root itself", { instructionsEntryFile: "." }, rootPath],
  ])("rejects %s outside the instruction bundle", (_name, override, filePath) => {
    const config = {
      instructionsRootPath: rootPath,
      ...override,
    };

    expect(resolveCodexInstructionsBundle(config)).toEqual({
      filePath,
      rootPath: null,
      entryRelativePath: null,
    });
  });
});
