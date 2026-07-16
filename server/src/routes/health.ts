import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus, writeDevServerRestartRequest } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { getServerInfoSnapshot, type ServerInfoSnapshot } from "../server-info.js";
import {
  getCloudStackContext,
  isCloudManagedInstance,
  type CloudInstanceEnv,
} from "../services/cloud-instance.js";
import {
  inspectDatabaseBackupHealth,
  type DatabaseBackupHealthStatus,
  type DatabaseBackupHealthWarning,
  type InspectDatabaseBackupHealthOptions,
} from "../services/database-backup-health.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function redactedDatabaseBackupWarning(warning: DatabaseBackupHealthWarning): DatabaseBackupHealthWarning {
  const messages: Record<DatabaseBackupHealthWarning["code"], string> = {
    database_backup_check_failed: "Database backup health check failed.",
    database_backup_last_failure: "Database backup failure marker is present.",
    database_backup_missing: "No recent database backup was found.",
    database_backup_stale: "Latest database backup is stale.",
  };
  return {
    code: warning.code,
    message: messages[warning.code],
  };
}

function redactedDatabaseBackupHealth(databaseBackup: DatabaseBackupHealthStatus) {
  return {
    enabled: databaseBackup.enabled,
    status: databaseBackup.status,
    warnings: databaseBackup.warnings.map(redactedDatabaseBackupWarning),
  };
}

function getCloudHealthStatus(env: CloudInstanceEnv) {
  const context = getCloudStackContext(env);
  if (!context) return undefined;

  return {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: context.stackSlug,
    cloudBaseUrl: context.cloudOrigin,
  };
}

// INC-2026-07-14-001 (DRO-1075/DRO-1077): an orphaned agent-wake transaction held a row
// lock with no timeout, chaining concurrent DB work and exhausting the connection pool.
// Readiness's own `SELECT 1` probe rode the same pool, so it hung too -- Docker's
// healthcheck timeout (see docker/docker-compose.yml) eventually fired, but only after
// the container had already been wedged for the full unhealthy `retries` window.
// Bound the DB probe itself well below that timeout so readiness fails fast with a
// clear "degraded" JSON body instead of hanging until Docker gives up.
const DEFAULT_READINESS_DB_PROBE_TIMEOUT_MS = 3_000;

function readinessDbProbeTimeoutMs(): number {
  const raw = process.env.PAPERCLIP_HEALTH_DB_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_READINESS_DB_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READINESS_DB_PROBE_TIMEOUT_MS;
}

class DatabaseProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Database readiness probe did not complete within ${timeoutMs}ms`);
    this.name = "DatabaseProbeTimeoutError";
  }
}

type DatabaseReadinessProbeState = {
  query: Promise<void>;
  result: Promise<void>;
};

const databaseReadinessProbes = new WeakMap<object, DatabaseReadinessProbeState>();

function startDatabaseReadinessQuery(db: Db) {
  const client = (db as Db & {
    $client?: { unsafe?: (query: string) => Promise<unknown> & { cancel?: () => void } };
  }).$client;
  if (client && typeof client.unsafe === "function") {
    const pending = client.unsafe("SELECT 1");
    return {
      query: pending.then(() => undefined),
      cancel: () => pending.cancel?.(),
    };
  }

  return {
    query: Promise.resolve(db.execute(sql`SELECT 1`)).then(() => undefined),
    cancel: undefined,
  };
}

async function probeDatabaseReadiness(db: Db, timeoutMs: number): Promise<void> {
  const key = db as object;
  let state = databaseReadinessProbes.get(key);
  if (!state) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { query, cancel } = startDatabaseReadinessQuery(db);
    const createdState: DatabaseReadinessProbeState = {
      query,
      result: Promise.resolve(),
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DatabaseProbeTimeoutError(timeoutMs));
        try {
          cancel?.();
        } catch (error) {
          logger.warn({ err: error }, "Failed to cancel timed-out database health probe");
        }
      }, timeoutMs);
    });
    createdState.result = Promise.race([query, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    databaseReadinessProbes.set(key, createdState);
    state = createdState;

    // Keep a timed-out probe single-flight while postgres-js cancels it. If cancellation
    // itself never settles, remaining degraded is safer than queuing more DB work.
    void query
      .finally(() => {
        if (databaseReadinessProbes.get(key) === createdState) {
          databaseReadinessProbes.delete(key);
        }
      })
      .catch(() => undefined);
  }

  await state.result;
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    serverInfo?: ServerInfoSnapshot;
    databaseBackupHealth?: InspectDatabaseBackupHealthOptions;
    runtimeEnv?: CloudInstanceEnv;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.post("/dev-server/restart", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (opts.deploymentMode === "authenticated" && actorType !== "board") {
      res.status(403).json({ error: "board_access_required" });
      return;
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    if (!persistedDevServerStatus) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    const restartRequired =
      persistedDevServerStatus.dirty ||
      persistedDevServerStatus.changedPathCount > 0 ||
      persistedDevServerStatus.pendingMigrations.length > 0;
    if (!restartRequired) {
      res.status(409).json({ error: "restart_not_required" });
      return;
    }

    const written = writeDevServerRestartRequest({
      requestedAt: new Date().toISOString(),
      reason: "manual_restart_now",
    });
    if (!written) {
      res.status(404).json({ error: "dev_server_supervisor_unavailable" });
      return;
    }

    res.status(202).json({ status: "restart_requested" });
  });

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    const runtimeEnv = opts.runtimeEnv ?? process.env;
    const cloud = getCloudHealthStatus(runtimeEnv);
    // serverInfo (git SHA + process start) rides on the full-details responses
    // only, so it reaches board/agent actors in authenticated mode or any caller
    // in local_trusted dev — never anonymous authenticated callers. The
    // enableServerInfoDebugView experimental flag gates the UI surface, not this
    // already access-controlled field.
    const serverInfo = opts.serverInfo ?? getServerInfoSnapshot();
    // The build commit is a plain git SHA of a public repository — not a
    // secret — so it is surfaced on every response, including the redacted
    // one, unlike the fuller `serverInfo` block. Deploy tooling (and anyone)
    // can read which commit this server is running without authenticating.
    const commit = serverInfo.git.available ? serverInfo.git.fullSha : null;
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      res.json(
        exposeFullDetails
          ? {
              status: "ok",
              version: serverVersion,
              serverVersion: serverVersion,
              commit,
              serverInfo,
              ...(cloud ? { cloud } : {}),
            }
          : {
              status: "ok",
              deploymentMode: opts.deploymentMode,
              commit,
              ...(cloud ? { cloud } : {}),
            },
      );
      return;
    }

    try {
      await probeDatabaseReadiness(db, readinessDbProbeTimeoutMs());
    } catch (error) {
      const isTimeout = error instanceof DatabaseProbeTimeoutError;
      logger.warn({ err: error, timedOut: isTimeout }, "Health check database probe failed");
      // The HTTP process is alive, but this combined health/readiness endpoint returns 503
      // because its DB dependency is unavailable or too slow. The structured degraded body
      // distinguishes that dependency failure from an unresponsive process.
      res.status(503).json({
        status: "degraded",
        error: isTimeout ? "database_timeout" : "database_unreachable",
        commit,
        ...(exposeFullDetails
          ? { version: serverVersion, serverVersion, serverInfo }
          : {
              deploymentMode: opts.deploymentMode,
              deploymentExposure: opts.deploymentExposure,
            }),
        ...(cloud ? { cloud } : {}),
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    // Cloud-managed instances have no first-admin concept: the control
    // plane owns identity and its trusted-header users are deliberately
    // never instance_admin, so the role-count gate below would report
    // bootstrap_pending forever and lock every managed tenant out at the
    // claim screen. Self-hosted deployments (neither canonical managed signal)
    // are unaffected.
    if (opts.deploymentMode === "authenticated" && !isCloudManagedInstance(runtimeEnv)) {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    const databaseBackup = opts.databaseBackupHealth
      ? inspectDatabaseBackupHealth(opts.databaseBackupHealth)
      : undefined;
    const warnings = databaseBackup?.warnings.length ? databaseBackup.warnings : undefined;

    if (!exposeFullDetails) {
      const redactedDatabaseBackup = databaseBackup ? redactedDatabaseBackupHealth(databaseBackup) : undefined;
      const redactedWarnings = redactedDatabaseBackup?.warnings.length ? redactedDatabaseBackup.warnings : undefined;
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        commit,
        bootstrapStatus,
        bootstrapInviteActive,
        ...(redactedDatabaseBackup ? { databaseBackup: redactedDatabaseBackup } : {}),
        ...(redactedWarnings ? { warnings: redactedWarnings } : {}),
        ...(devServer ? { devServer } : {}),
        ...(cloud ? { cloud } : {}),
      });
      return;
    }

    res.json({
      status: "ok",
      version: serverVersion,
      serverVersion,
      commit,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      serverInfo,
      ...(databaseBackup ? { databaseBackup } : {}),
      ...(warnings ? { warnings } : {}),
      ...(devServer ? { devServer } : {}),
      ...(cloud ? { cloud } : {}),
    });
  });

  return router;
}
