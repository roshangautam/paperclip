import {
  PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY,
  PLUGIN_RPC_ERROR_CODES,
} from "@paperclipai/plugin-sdk";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  claim: vi.fn(),
  release: vi.fn(),
  getStatus: vi.fn(),
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
    uid?: string,
  ) => {
    await clients.batch.deleteNamespacedJob({
      namespace,
      name,
      propagationPolicy: "Foreground",
      ...(uid ? { body: { preconditions: { uid } } } : {}),
    });
  },
  jobOrchestrator: {
    claim: h.claim,
    release: h.release,
    getStatus: h.getStatus,
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

function ownedChild(acquisitionId: string, uid: string, ownerUid?: string) {
  return {
    metadata: {
      uid,
      labels: {
        "paperclip.io/managed-by": "paperclip-k8s-plugin",
        "paperclip.io/acquisition-id": acquisitionId,
      },
      ...(ownerUid ? { ownerReferences: [{ uid: ownerUid }] } : {}),
    },
  };
}

beforeEach(() => {
  h.clients = {};
  h.claim.mockReset();
  h.release.mockReset();
  h.getStatus.mockReset().mockResolvedValue({ phase: "Pending" });
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

  it.each([
    ["newly created", true],
    ["adopted", false],
  ])("hands off a %s workload when local setup fails", async (_kind, created) => {
    h.claim.mockResolvedValue({ uid: "uid-1", created });
    h.createPerRunSecret.mockRejectedValue(new Error("secret setup failed"));

    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "secret setup failed",
      data: {
        providerLeaseId: expectedJobName,
        cleanupVerifiedAcquisitionId: acquisitionId,
      },
    });

    expect(h.release).not.toHaveBeenCalled();
    expect(h.createPerRunSecret).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ createIfMissing: true }),
    );
  });

  it("does not replace a missing Secret for a running adopted workload", async () => {
    h.claim.mockResolvedValue({ uid: "uid-1", created: false });
    h.getStatus.mockResolvedValue({ phase: "Running" });
    h.createPerRunSecret.mockRejectedValue(new Error("adopted workload secret is missing"));

    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({
      data: { providerLeaseId: expectedJobName },
    });
    expect(h.createPerRunSecret).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ createIfMissing: false }),
    );
  });

  it("does not fail acquisition when initial pod discovery is unavailable", async () => {
    h.claim.mockResolvedValue({ uid: "uid-1", created: true });
    h.createPerRunSecret.mockResolvedValue({ created: true });
    h.findPod.mockRejectedValue(new Error("pod list unavailable"));

    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).resolves.toMatchObject({
      providerLeaseId: expectedJobName,
      metadata: { podName: null, workloadUid: "uid-1" },
    });
  });
});

describe("onEnvironmentReleaseLease", () => {
  const acquisitionId = "acquisition-release";
  const providerLeaseId = deriveAcquisitionResourceName(acquisitionId);
  const params = {
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    acquisitionId,
    providerLeaseId,
    config: { inCluster: true, backend: "job" },
    leaseMetadata: { namespace: "paperclip-acme", backend: "job" },
  };

  function ownedJob(labels: Record<string, string> = {}): Record<string, unknown> {
    return {
      metadata: {
        uid: "job-uid",
        labels: {
          "paperclip.io/managed-by": "paperclip-k8s-plugin",
          "paperclip.io/acquisition-id": acquisitionId,
          ...labels,
        },
      },
    };
  }

  it("deletes a workload only after verifying acquisition ownership", async () => {
    const readJob = vi.fn().mockResolvedValue(ownedJob());
    h.clients = { batch: { readNamespacedJob: readJob } };

    await plugin.definition.onEnvironmentReleaseLease!(params);

    expect(readJob).toHaveBeenCalledWith({ namespace: "paperclip-acme", name: providerLeaseId });
    expect(h.release).toHaveBeenCalledWith(
      h.clients,
      "paperclip-acme",
      providerLeaseId,
      "job-uid",
    );
  });

  it("refuses to delete a deterministic-name collision owned by another acquisition", async () => {
    h.clients = {
      batch: {
        readNamespacedJob: vi.fn().mockResolvedValue(ownedJob({
          "paperclip.io/acquisition-id": "another-acquisition",
        })),
      },
    };

    await expect(plugin.definition.onEnvironmentReleaseLease!(params)).rejects.toThrow(
      "acquisition ownership does not match",
    );
    expect(h.release).not.toHaveBeenCalled();
  });

  it("keeps an exact-name 404 retryable without prior ownership verification", async () => {
    h.clients = {
      batch: { readNamespacedJob: vi.fn().mockRejectedValue(notFound()) },
    };

    await expect(plugin.definition.onEnvironmentReleaseLease!(params)).rejects.toThrow(
      "cleanup must be retried",
    );
    expect(h.release).not.toHaveBeenCalled();
  });

  it("accepts an exact-name 404 after prior ownership verification", async () => {
    h.clients = {
      batch: { readNamespacedJob: vi.fn().mockRejectedValue(notFound()) },
    };
    h.release.mockRejectedValue(notFound());

    await expect(plugin.definition.onEnvironmentReleaseLease!({
      ...params,
      leaseMetadata: {
        ...params.leaseMetadata,
        [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId,
      },
    })).resolves.toBeUndefined();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("accepts an exact-name 404 with a persisted workload UID", async () => {
    h.clients = {
      batch: { readNamespacedJob: vi.fn().mockRejectedValue(notFound()) },
    };
    h.release.mockRejectedValue(notFound());

    await expect(plugin.definition.onEnvironmentReleaseLease!({
      ...params,
      leaseMetadata: {
        ...params.leaseMetadata,
        acquisitionId,
        workloadUid: "job-uid",
      },
    })).resolves.toBeUndefined();
    expect(h.release).toHaveBeenCalledWith(
      h.clients,
      "paperclip-acme",
      providerLeaseId,
      "job-uid",
    );
  });

  it("preserves verified ownership when deletion fails", async () => {
    h.clients = {
      batch: { readNamespacedJob: vi.fn().mockResolvedValue(ownedJob()) },
    };
    h.release.mockRejectedValue(new Error("delete failed"));

    await expect(plugin.definition.onEnvironmentReleaseLease!(params)).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "delete failed",
      data: {
        providerLeaseId,
        [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId,
      },
    });
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

  it.each([
    ["UID", "other-uid", "acquisition-resume"],
    ["acquisition ownership", "workload-uid", "other-acquisition"],
  ])("refuses resume when persisted %s does not match", async (_kind, uid, labelAcquisitionId) => {
    const acquisitionId = "acquisition-resume";
    const providerLeaseId = deriveAcquisitionResourceName(acquisitionId);
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({
          metadata: {
            uid,
            labels: {
              "paperclip.io/managed-by": "paperclip-k8s-plugin",
              "paperclip.io/acquisition-id": labelAcquisitionId,
            },
          },
        }),
      },
    };

    await expect(plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId,
      leaseMetadata: leaseMetadata({ acquisitionId, workloadUid: "workload-uid" }),
    })).rejects.toThrow(_kind);
  });
});

describe("onEnvironmentDestroyLease", () => {
  it("refuses a deterministic-name collision without deleting any resources", async () => {
    const acquisitionId = "acquisition-destroy-collision";
    const providerLeaseId = deriveAcquisitionResourceName(acquisitionId);
    const deleteJob = vi.fn();
    const deletePod = vi.fn();
    const deleteSecret = vi.fn();
    h.clients = {
      custom: {},
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue(
          ownedChild(acquisitionId, "pod-uid", "workload-uid"),
        ),
        readNamespacedSecret: vi.fn().mockResolvedValue(
          ownedChild(acquisitionId, "secret-uid", "workload-uid"),
        ),
        deleteNamespacedPod: deletePod,
        deleteNamespacedSecret: deleteSecret,
      },
      batch: {
        readNamespacedJob: vi.fn().mockResolvedValue({
          metadata: {
            labels: {
              "paperclip.io/managed-by": "paperclip-k8s-plugin",
              "paperclip.io/acquisition-id": "another-acquisition",
            },
          },
        }),
        deleteNamespacedJob: deleteJob,
      },
    };

    await expect(plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      acquisitionId,
      config: { inCluster: true, backend: "job" },
      providerLeaseId,
      leaseMetadata: leaseMetadata({
        jobName: providerLeaseId,
        backend: "job",
        podName: `${providerLeaseId}-pod`,
        secretName: `${providerLeaseId}-env`,
      }),
    })).rejects.toThrow("acquisition ownership does not match");

    expect(deleteJob).not.toHaveBeenCalled();
    expect(deletePod).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("refuses to delete a replaced child resource", async () => {
    const acquisitionId = "acquisition-destroy-child";
    const providerLeaseId = deriveAcquisitionResourceName(acquisitionId);
    const deleteJob = vi.fn().mockResolvedValue({});
    const deletePod = vi.fn();
    const deleteSecret = vi.fn();
    h.clients = {
      custom: {},
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue(
          ownedChild(acquisitionId, "replacement-pod-uid", "other-workload-uid"),
        ),
        readNamespacedSecret: vi.fn(),
        deleteNamespacedPod: deletePod,
        deleteNamespacedSecret: deleteSecret,
      },
      batch: {
        readNamespacedJob: vi.fn().mockResolvedValue({
          metadata: {
            uid: "workload-uid",
            labels: {
              "paperclip.io/managed-by": "paperclip-k8s-plugin",
              "paperclip.io/acquisition-id": acquisitionId,
            },
          },
        }),
        deleteNamespacedJob: deleteJob,
      },
    };

    await expect(plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      acquisitionId,
      config: { inCluster: true, backend: "job" },
      providerLeaseId,
      leaseMetadata: leaseMetadata({
        acquisitionId,
        workloadUid: "workload-uid",
        jobName: providerLeaseId,
        backend: "job",
        podName: `${providerLeaseId}-pod`,
        secretName: `${providerLeaseId}-env`,
      }),
    })).rejects.toThrow(/owner does not match workload/);

    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({
      body: { preconditions: { uid: "workload-uid" } },
    }));
    expect(deletePod).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("continues idempotent destroy after a verified workload 404", async () => {
    const acquisitionId = "acquisition-destroy-gone";
    const providerLeaseId = deriveAcquisitionResourceName(acquisitionId);
    const deleteJob = vi.fn().mockRejectedValue(notFound());
    const deletePod = vi.fn().mockRejectedValue(notFound());
    const deleteSecret = vi.fn().mockRejectedValue(notFound());
    h.clients = {
      custom: {},
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue(
          ownedChild(acquisitionId, "pod-uid", "workload-uid"),
        ),
        readNamespacedSecret: vi.fn().mockResolvedValue(
          ownedChild(acquisitionId, "secret-uid", "workload-uid"),
        ),
        deleteNamespacedPod: deletePod,
        deleteNamespacedSecret: deleteSecret,
      },
      batch: {
        readNamespacedJob: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedJob: deleteJob,
      },
    };

    await expect(plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      acquisitionId,
      config: { inCluster: true, backend: "job" },
      providerLeaseId,
      leaseMetadata: leaseMetadata({
        jobName: providerLeaseId,
        backend: "job",
        podName: `${providerLeaseId}-pod`,
        secretName: `${providerLeaseId}-env`,
        acquisitionId,
        workloadUid: "workload-uid",
      }),
    })).resolves.toBeUndefined();

    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({
      body: { preconditions: { uid: "workload-uid" } },
    }));
    expect(deletePod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: `${providerLeaseId}-pod`,
      body: { preconditions: { uid: "pod-uid" } },
    });
    expect(deleteSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: `${providerLeaseId}-env`,
      body: { preconditions: { uid: "secret-uid" } },
    });
  });

  it("deletes the Sandbox CR, pod, and per-run Secret", async () => {
    const deleteCr = vi.fn().mockResolvedValue({});
    const deletePod = vi.fn().mockResolvedValue({});
    const deleteSecret = vi.fn().mockResolvedValue({});
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue({ metadata: { uid: "workload-uid" } }),
        deleteNamespacedCustomObject: deleteCr,
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue(
          {
            metadata: {
              uid: "pod-uid",
              labels: { "agents.x-k8s.io/sandbox-name-hash": "hash" },
              ownerReferences: [{ uid: "workload-uid" }],
            },
          },
        ),
        readNamespacedSecret: vi.fn().mockResolvedValue(
          ownedChild("unused", "secret-uid", "workload-uid"),
        ),
        deleteNamespacedPod: deletePod,
        deleteNamespacedSecret: deleteSecret,
      },
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

    expect(deleteCr).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "paperclip-acme",
      name: "pc-abc",
      body: { preconditions: { uid: "workload-uid" } },
    }));
    expect(deletePod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-pod",
      body: { preconditions: { uid: "pod-uid" } },
    });
    expect(deleteSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-env",
      body: { preconditions: { uid: "secret-uid" } },
    });
  });

  it("is idempotent: resolves cleanly when every resource is already gone (404)", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedCustomObject: vi.fn(),
      },
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
        readNamespacedPod: vi.fn().mockResolvedValue(
          ownedChild("unused", "pod-uid", "workload-uid"),
        ),
        readNamespacedSecret: vi.fn().mockResolvedValue(
          ownedChild("unused", "secret-uid", "workload-uid"),
        ),
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      },
      batch: {
        readNamespacedJob: vi.fn().mockResolvedValue({ metadata: { uid: "workload-uid" } }),
        deleteNamespacedJob: deleteJob,
      },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod", secretName: "pc-job-env" }),
    });

    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "paperclip-acme",
      name: "pc-job",
      body: { preconditions: { uid: "workload-uid" } },
    }));
    expect(deleteCr).not.toHaveBeenCalled();
  });
});
