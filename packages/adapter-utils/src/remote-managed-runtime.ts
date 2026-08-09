import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  removeDirectoryFromSsh,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

const ACP_WORKSPACE_RESTORE_ERROR_CODE = "acp_workspace_restore_failed";
export const ACP_REMOTE_RUN_CLEANUP_ERROR_CODE = "acp_remote_run_cleanup_failed";
const REMOTE_RUN_CLEANUP_ATTEMPTS = 3;

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remoteWorkspaceCleanupFailure(
  operationError: unknown,
  cleanupError: unknown,
  action: string,
): Error {
  return Object.assign(
    new Error(
      `${errorMessageFromUnknown(operationError)}\n${action}: ${errorMessageFromUnknown(cleanupError)}`,
    ),
    {
      code: ACP_WORKSPACE_RESTORE_ERROR_CODE,
      cause: operationError,
      operationError,
      restoreError: cleanupError,
    },
  );
}

async function removeRemoteRunRoot(input: {
  spec: SshRemoteExecutionSpec;
  remoteDir: string;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REMOTE_RUN_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await removeDirectoryFromSsh(input);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  assets?: RemoteManagedRuntimeAsset[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  if (
    input.runId.length === 0 ||
    input.runId === "." ||
    input.runId === ".." ||
    path.posix.basename(input.runId) !== input.runId ||
    input.runId.includes("\0")
  ) {
    throw new Error("runId must be a single safe path segment");
  }
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const runRootDir = path.posix.join(
    baseWorkspaceRemoteDir,
    ".paperclip-runtime",
    "runs",
    input.runId,
  );
  const workspaceRemoteDir = path.posix.join(runRootDir, "workspace");
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);

  let preparedWorkspace: Awaited<ReturnType<typeof prepareWorkspaceForSshExecution>>;
  let baselineSnapshot: Awaited<ReturnType<typeof captureDirectorySnapshot>>;
  try {
    preparedWorkspace = await prepareWorkspaceForSshExecution({
      spec: input.spec,
      localDir: input.workspaceLocalDir,
      remoteDir: workspaceRemoteDir,
      onProgress: input.onProgress,
    });
    const restoreExclude = preparedWorkspace.gitBacked
      ? [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime"]
      : [".paperclip-runtime"];
    baselineSnapshot = await captureDirectorySnapshot(input.workspaceLocalDir, {
      exclude: restoreExclude,
    });
  } catch (preparationError) {
    try {
      await removeRemoteRunRoot({ spec: input.spec, remoteDir: runRootDir });
    } catch (cleanupError) {
      throw remoteWorkspaceCleanupFailure(
        preparationError,
        cleanupError,
        "Remote run workspace cleanup failed after preparation",
      );
    }
    throw preparationError;
  }

  const assetDirs: Record<string, string> = {};
  const restoreWorkspace = async (onProgress?: RuntimeProgressSink) => {
    await restoreWorkspaceFromSshExecution({
      spec: input.spec,
      localDir: input.workspaceLocalDir,
      remoteDir: workspaceRemoteDir,
      baselineSnapshot,
      restoreGitHistory: preparedWorkspace.gitBacked,
      onProgress,
    });
    try {
      await removeRemoteRunRoot({ spec: input.spec, remoteDir: runRootDir });
    } catch (cleanupError) {
      try {
        await onProgress?.(
          `[paperclip] Remote run workspace cleanup failed after successful sync-back; local workspace changes were preserved: ${errorMessageFromUnknown(cleanupError)}\n`,
        );
      } catch {
        // Sync-back already succeeded, so warning delivery remains best-effort.
      }
      throw Object.assign(
        new Error(
          `Remote run workspace cleanup failed after successful sync-back: ${errorMessageFromUnknown(cleanupError)}`,
        ),
        {
          code: ACP_REMOTE_RUN_CLEANUP_ERROR_CODE,
          cause: cleanupError,
          workspaceRestored: true,
          remoteRunDir: runRootDir,
        },
      );
    }
  };
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
      });
    }
  } catch (error) {
    try {
      await restoreWorkspace(input.onProgress);
    } catch (restoreError) {
      if (
        restoreError &&
        typeof restoreError === "object" &&
        "code" in restoreError &&
        restoreError.code === ACP_REMOTE_RUN_CLEANUP_ERROR_CODE &&
        "workspaceRestored" in restoreError &&
        restoreError.workspaceRestored === true
      ) {
        Object.assign(restoreError, { operationError: error });
        throw restoreError;
      }
      throw remoteWorkspaceCleanupFailure(
        error,
        restoreError,
        "Remote workspace restore failed after asset staging",
      );
    }
    throw error;
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    restoreWorkspace,
  };
}
