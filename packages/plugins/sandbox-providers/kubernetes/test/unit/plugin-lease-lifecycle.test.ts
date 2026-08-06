import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  claim: vi.fn(),
  release: vi.fn(),
  findPod: vi.fn(),
  createPerRunSecret: vi.fn(),
  ensureTenant: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/tenant-orchestrator.js", () => ({
  ensureTenant: h.ensureTenant,
}));

vi.mock("../../src/secret-manager.js", () => ({
  createPerRunSecret: h.createPerRunSecret,
}));

vi.mock("../../src/job-orchestrator.js", () => ({
  JobTimeoutError: class JobTimeoutError extends Error {},
  deleteJob: async (
    clients: { batch: { deleteNamespacedJob(input: Record<string, unknown>): Promise<unknown> } },
    namespace: string,
    name: string,
  ) => {
    await clients.batch.deleteNamespacedJob({ namespace, name, propagationPolicy: "Foreground" });
  },
  jobOrchestrator: {
    claim: h.claim,
    release: h.release,
    findPod: h.findPod,
    waitForCompletion: vi.fn(),
    streamLogs: vi.fn(),
  },
}));

import plugin from "../../src/plugin.js";
import { deriveAcquisitionResourceName } from "../../src/utils.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function leaseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: "paperclip-acme",
    jobName: "pc-abc",
    podName: "pc-abc-pod",
    secretName: "pc-abc-env",
    phase: "Pending",
    backend: "sandbox-cr",
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function readySandboxCr(podName: string): Record<string, unknown> {
  return {
    metadata: { uid: "uid-1" },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      podName,
    },
  };
}

beforeEach(() => {
  h.clients = {};
  h.claim.mockReset();
  h.release.mockReset();
  h.findPod.mockReset();
  h.createPerRunSecret.mockReset();
  h.ensureTenant.mockReset().mockResolvedValue(undefined);
});

describe("onEnvironmentAcquireLease", () => {
  const acquisitionId = "acquisition-handoff";
  const expectedJobName = deriveAcquisitionResourceName(acquisitionId);
  const params = {
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    acquisitionId,
    runId: "run-1",
    config: { inCluster: true, backend: "job" },
  };

  it("hands off an adopted workload when local setup fails", async () => {
    h.claim.mockResolvedValue({ uid: "uid-1", created: false });
    h.createPerRunSecret.mockRejectedValue(new Error("secret setup failed"));

    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "secret setup failed",
      data: { providerLeaseId: expectedJobName },
    });

    expect(h.release).not.toHaveBeenCalled();
  });

  it("hands off a newly created workload when setup cleanup fails", async () => {
    h.claim.mockResolvedValue({ uid: "uid-1", created: true });
    h.createPerRunSecret.mockRejectedValue(new Error("secret setup failed"));
    h.release.mockRejectedValue(new Error("delete failed"));

    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "secret setup failed",
      data: { providerLeaseId: expectedJobName },
    });

    expect(h.release).toHaveBeenCalledWith(h.clients, "paperclip-acme", expectedJobName);
  });

  it("rethrows the setup error after a newly created workload is confirmed cleaned up", async () => {
    const setupError = new Error("secret setup failed");
    h.claim.mockResolvedValue({ uid: "uid-1", created: true });
    h.createPerRunSecret.mockRejectedValue(setupError);
    h.release.mockResolvedValue(undefined);

    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toBe(setupError);
    expect(h.release).toHaveBeenCalledWith(h.clients, "paperclip-acme", expectedJobName);
  });
});

describe("onEnvironmentResumeLease", () => {
  it("is implemented (Daytona feature parity)", () => {
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  it("returns a valid lease handle for a live sandbox-cr lease", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: {},
          status: { phase: "Running" },
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        namespace: "paperclip-acme",
        jobName: "pc-abc",
        podName: "pc-abc-pod",
        secretName: "pc-abc-env",
        phase: "Running",
        backend: "sandbox-cr",
        resumedLease: true,
      }),
    );
  });

  it("returns providerLeaseId null (expired) when the Sandbox CR is gone, so the caller falls back to acquireLease", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { readNamespacedPod: vi.fn() },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
    expect(lease.metadata?.reason).toMatch(/no longer exists/);
  });

  it("returns providerLeaseId null when the backing pod is gone", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: { readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
  });
});

describe("onEnvironmentDestroyLease", () => {
  it("deletes the Sandbox CR, pod, and per-run Secret", async () => {
    const deleteCr = vi.fn().mockResolvedValue({});
    const deletePod = vi.fn().mockResolvedValue({});
    const deleteSecret = vi.fn().mockResolvedValue({});
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: { deleteNamespacedPod: deletePod, deleteNamespacedSecret: deleteSecret },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(deleteCr).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
    expect(deletePod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-pod",
    });
    expect(deleteSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-env",
    });
  });

  it("is idempotent: resolves cleanly when every resource is already gone (404)", async () => {
    h.clients = {
      custom: { deleteNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: {
        deleteNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedSecret: vi.fn().mockRejectedValue(notFound()),
      },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await expect(
      plugin.definition.onEnvironmentDestroyLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        providerLeaseId: "pc-abc",
        leaseMetadata: leaseMetadata(),
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when providerLeaseId is null", async () => {
    const deleteCr = vi.fn();
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: { deleteNamespacedPod: vi.fn(), deleteNamespacedSecret: vi.fn() },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: null,
      leaseMetadata: undefined,
    });

    expect(deleteCr).not.toHaveBeenCalled();
  });

  it("deletes the Job for job-backend leases", async () => {
    const deleteJob = vi.fn().mockResolvedValue({});
    const deleteCr = vi.fn();
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      },
      batch: { deleteNamespacedJob: deleteJob },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod", secretName: "pc-job-env" }),
    });

    expect(deleteJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-job" }),
    );
    expect(deleteCr).not.toHaveBeenCalled();
  });
});
