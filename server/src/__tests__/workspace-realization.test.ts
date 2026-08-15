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
      reusableResourceOwner: false,
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

  it("stamps no ownership markers when no realization credentials are supplied", () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    const environment = {
      id: "environment-1",
      name: "Local environment",
      description: null,
      driver: "local",
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
      provider: "local",
      providerLeaseId: "provider-lease-1",
      acquiredAt: now,
      lastUsedAt: now,
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      reusableResourceOwner: false,
      metadata: { agentId: "agent-voss" },
      createdAt: now,
      updatedAt: now,
    } satisfies EnvironmentLease;

    const record = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: "/tmp/project",
    });

    const providerMetadata = record.rebuild.metadata.providerMetadata as Record<string, unknown>;
    expect(providerMetadata.agentId).toBeUndefined();
    expect(providerMetadata.credentialAgentId).toBeUndefined();
  });

  it("stamps the credential owner when realization credentials are supplied", () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    const environment = {
      id: "environment-1",
      name: "Local environment",
      description: null,
      driver: "local",
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
      provider: "local",
      providerLeaseId: "provider-lease-1",
      acquiredAt: now,
      lastUsedAt: now,
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      reusableResourceOwner: false,
      metadata: { agentId: "agent-voss" },
      createdAt: now,
      updatedAt: now,
    } satisfies EnvironmentLease;

    const record = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: "/tmp/project",
      credentialOwnerAgentId: "agent-voss",
    });

    const providerMetadata = record.rebuild.metadata.providerMetadata as Record<string, unknown>;
    expect(providerMetadata.agentId).toBe("agent-voss");
    expect(providerMetadata.credentialAgentId).toBe("agent-voss");
  });

  it("redacts credential-shaped values echoed back in provider realization metadata", () => {
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
      reusableResourceOwner: false,
      metadata: { agentId: "agent-voss" },
      createdAt: now,
      updatedAt: now,
    } satisfies EnvironmentLease;

    const record = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: "/home/plugin/workspace",
      providerMetadata: {
        remoteCwd: "/home/plugin/workspace",
        accessToken: "ghs_super_secret_realization_token",
        sandboxId: "sbx-123",
      },
      credentialOwnerAgentId: "agent-voss",
    });

    const providerMetadata = record.rebuild.metadata.providerMetadata as Record<string, unknown>;
    expect(providerMetadata.accessToken).not.toBe("ghs_super_secret_realization_token");
    expect(providerMetadata.remoteCwd).toBe("/home/plugin/workspace");
    expect(providerMetadata.sandboxId).toBe("sbx-123");
    expect(providerMetadata.credentialAgentId).toBe("agent-voss");
    expect(JSON.stringify(record)).not.toContain("ghs_super_secret_realization_token");
  });

  it("strips forwarded credentials smuggled into provider-returned paths", () => {
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
      reusableResourceOwner: false,
      metadata: { agentId: "agent-voss" },
      createdAt: now,
      updatedAt: now,
    } satisfies EnvironmentLease;

    const leakedPrefix = "github_pat_prefix";
    const leaked = "github_pat_prefix_tail";
    const record = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: `/home/plugin/${leaked}/workspace`,
      providerMetadata: {
        remoteCwd: `/home/plugin/${leaked}/workspace`,
        sandboxId: "sbx-123",
      },
      credentialOwnerAgentId: "agent-voss",
      forwardedCredentialValues: [leakedPrefix, leaked],
    });

    expect(record.remote.path).not.toContain(leakedPrefix);
    expect(record.remote.path).not.toContain("_tail");
    expect(JSON.stringify(record)).not.toContain(leaked);
    expect(record.rebuild.remotePath).not.toContain(leaked);
    expect(record.summary).not.toContain(leaked);
  });

  it("strips forwarded credentials smuggled into identifier-shaped metadata fields", () => {
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
      reusableResourceOwner: false,
      metadata: { agentId: "agent-voss" },
      createdAt: now,
      updatedAt: now,
    } satisfies EnvironmentLease;

    const leaked = "github_pat_smuggled_in_identifier_field";
    const record = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: "/home/plugin/workspace",
      providerMetadata: {
        remoteCwd: "/home/plugin/workspace",
        sandboxId: leaked,
        nested: { accessRef: leaked, list: [leaked] },
      },
      credentialOwnerAgentId: "agent-voss",
      forwardedCredentialValues: [leaked],
    });

    expect(record.remote.sandboxId).not.toBe(leaked);
    expect(record.summary).not.toContain(leaked);
    const providerMetadata = record.rebuild.metadata.providerMetadata as Record<string, unknown>;
    expect(providerMetadata.sandboxId).not.toBe(leaked);
    expect(JSON.stringify(record)).not.toContain(leaked);
  });

  it("strips the JSON-escaped form of a forwarded multiline credential", () => {
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
      reusableResourceOwner: false,
      metadata: { agentId: "agent-voss" },
      createdAt: now,
      updatedAt: now,
    } satisfies EnvironmentLease;

    const privateKey = "-----BEGIN PRIVATE KEY-----\nline-one\nline-two\n-----END PRIVATE KEY-----";
    const escaped = JSON.stringify(privateKey).slice(1, -1);
    const record = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: "/home/plugin/workspace",
      providerMetadata: {
        remoteCwd: "/home/plugin/workspace",
        sandboxId: escaped,
      },
      credentialOwnerAgentId: "agent-voss",
      forwardedCredentialValues: [privateKey],
    });

    const providerMetadata = record.rebuild.metadata.providerMetadata as Record<string, unknown>;
    expect(providerMetadata.sandboxId).not.toBe(escaped);
    expect(JSON.stringify(record)).not.toContain("line-one");
    expect(JSON.stringify(record)).not.toContain("line-two");
  });

  it("strips a forwarded credential smuggled in as a metadata property name", () => {
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
      reusableResourceOwner: false,
      metadata: { agentId: "agent-voss" },
      createdAt: now,
      updatedAt: now,
    } satisfies EnvironmentLease;

    const leaked = "github_pat_smuggled_as_property_name";
    const record = buildWorkspaceRealizationRecordFromDriverInput({
      environment,
      lease,
      workspace: { localPath: "/tmp/project" },
      cwd: "/home/plugin/workspace",
      providerMetadata: {
        remoteCwd: "/home/plugin/workspace",
        sandboxId: "sandbox-1",
        [leaked]: "value",
        nested: { [leaked]: "value" },
      },
      credentialOwnerAgentId: "agent-voss",
      forwardedCredentialValues: [leaked],
    });

    expect(JSON.stringify(record)).not.toContain(leaked);
  });
});
