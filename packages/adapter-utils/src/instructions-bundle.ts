import { statSync } from "node:fs";
import path from "node:path";
import { asString } from "./server-utils.js";

export type ManagedInstructionsBundle = {
  filePath: string;
  rootPath: string | null;
  entryRelativePath: string | null;
};

export function resolveManagedInstructionsBundle(config: Record<string, unknown>): ManagedInstructionsBundle {
  const configuredFilePath = asString(config.instructionsFilePath, "").trim();
  const configuredRootPath = asString(config.instructionsRootPath, "").trim();
  const configuredEntryFile = asString(config.instructionsEntryFile, "").trim();
  const rootPath = configuredRootPath ? path.resolve(configuredRootPath) : null;
  const filePath = configuredFilePath || (
    rootPath && configuredEntryFile
      ? path.resolve(rootPath, configuredEntryFile)
      : ""
  );

  if (!rootPath || !filePath) {
    return { filePath, rootPath: null, entryRelativePath: null };
  }

  try {
    if (!statSync(rootPath).isDirectory()) {
      return { filePath, rootPath: null, entryRelativePath: null };
    }
  } catch {
    return { filePath, rootPath: null, entryRelativePath: null };
  }

  const entryPath = path.resolve(filePath);
  const entryRelativePath = path.relative(rootPath, entryPath);
  if (
    !entryRelativePath ||
    entryRelativePath === ".." ||
    entryRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(entryRelativePath)
  ) {
    return { filePath, rootPath: null, entryRelativePath: null };
  }

  try {
    if (!statSync(entryPath).isFile()) {
      return { filePath, rootPath: null, entryRelativePath: null };
    }
  } catch {
    return { filePath, rootPath: null, entryRelativePath: null };
  }

  return {
    filePath,
    rootPath,
    entryRelativePath: entryRelativePath.split(path.sep).join(path.posix.sep),
  };
}
