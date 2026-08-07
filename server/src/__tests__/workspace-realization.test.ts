import { describe, expect, it } from "vitest";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { buildWorkspaceRealizationRecordFromDriverInput } from "../services/workspace-realization.js";

describe("buildWorkspaceRealizationRecordFromDriverInput", () => {
  it("records the realized plugin cwd instead of stale provider metadata", () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    const environment = {
      id: "environment-1",
      name: "Plugin environment",
      description: null,
      driver: "plugin",
      status: "ready",
      config: {},
      envVars: {},
      metadata: null,
      createdAt: now,
      updatedAt: now,
    } satisfies Environment;
    const lease = {
      id: "lease-1",
      companyId: "company-1",
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      status: "active",
      leasePolicy: "ephemeral",
      provider: "acme.plugin-provider",
      providerLeaseId: "provider-lease-1",
      acquiredAt: now,
      lastUsedAt: now,
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      metadata: { remoteCwd: "/home/plugin/stale-lease" },
      createdAt: now,
      updatedAt: now,
    } satisfies EnvironmentLease;

    const record = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: " /home/plugin/fresh ",
      providerMetadata: { remoteCwd: "/home/plugin/stale-provider" },
    });

    expect(record.remote.path).toBe("/home/plugin/fresh");
    expect(record.rebuild.remotePath).toBe("/home/plugin/fresh");
    expect(record.sync.strategy).toBe("sandbox_archive_upload_download");
    expect(record.summary).toBe("Plugin workspace realized at /home/plugin/fresh.");

    const providerDefinedRecord = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: "/home/plugin/workspace",
      providerMetadata: {
        workspaceRealization: { sync: { strategy: "provider_defined" } },
      },
    });

    expect(providerDefinedRecord.sync.strategy).toBe("provider_defined");
  });
});
