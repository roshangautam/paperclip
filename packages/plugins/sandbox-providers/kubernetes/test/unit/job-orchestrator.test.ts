import {
  PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY,
  PLUGIN_RPC_ERROR_CODES,
} from "@paperclipai/plugin-sdk";
import { describe, it, expect, vi } from "vitest";
import { createJob, deleteJob, getJobStatus, findPodForJob, JobTimeoutError, waitForJobCompletion } from "../../src/job-orchestrator.js";

describe("createJob", () => {
  const acquisitionId = "acquisition-1";
  const labels = {
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
    "paperclip.io/acquisition-id": acquisitionId,
  };

  it("calls batch.createNamespacedJob with the manifest", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "abc-uid" } });
    const read = vi.fn().mockRejectedValue({ code: 404 });
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };
    const jobManifest = { apiVersion: "batch/v1", kind: "Job", metadata: { name: "r-1", namespace: "ns", labels }, spec: { template: {} } };
    const result = await createJob(clients as never, "ns", jobManifest, acquisitionId);
    expect(read).toHaveBeenCalledWith({ namespace: "ns", name: "r-1" });
    expect(create).toHaveBeenCalledWith({ namespace: "ns", body: jobManifest });
    expect(result.uid).toBe("abc-uid");
    expect(result.created).toBe(true);
  });

  it("adopts an existing exactly-owned Job without creating another", async () => {
    const read = vi.fn().mockResolvedValue({ metadata: { uid: "existing-uid", labels } });
    const create = vi.fn();
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };

    await expect(
      createJob(clients as never, "ns", { metadata: { name: "r-1", labels } }, acquisitionId),
    ).resolves.toEqual({ uid: "existing-uid", created: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a deterministic-name collision owned by another acquisition", async () => {
    const read = vi.fn().mockResolvedValue({
      metadata: {
        uid: "other-uid",
        labels: { ...labels, "paperclip.io/acquisition-id": "other-acquisition" },
      },
    });
    const create = vi.fn();
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };

    await expect(
      createJob(clients as never, "ns", { metadata: { name: "r-1" } }, acquisitionId),
    ).rejects.toThrow(/ownership does not match/);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not hand off a lease before create when the initial ownership read fails", async () => {
    const read = vi.fn().mockRejectedValue(new Error("API unavailable"));
    const create = vi.fn();
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };

    const failure = await createJob(
      clients as never,
      "ns",
      { metadata: { name: "r-1", labels } },
      acquisitionId,
    ).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ message: "API unavailable" });
    expect(failure).not.toHaveProperty("data");
    expect(create).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous create error by exact name and ownership", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce({ metadata: { uid: "committed-uid", labels } });
    const create = vi.fn().mockRejectedValue(new Error("response lost"));
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };

    await expect(
      createJob(clients as never, "ns", { metadata: { name: "r-1", labels } }, acquisitionId),
    ).resolves.toEqual({ uid: "committed-uid", created: false });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("preserves the deterministic lease id when an ambiguous create is not visible yet", async () => {
    const read = vi.fn().mockRejectedValue({ code: 404 });
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error("response lost"), { code: "ECONNRESET" }),
    );
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };

    await expect(
      createJob(clients as never, "ns", { metadata: { name: "r-1", labels } }, acquisitionId),
    ).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "response lost",
      data: {
        providerLeaseId: "r-1",
        [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId,
      },
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("preserves the deterministic lease id when reconciliation itself fails", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 503 });
    const create = vi.fn().mockRejectedValue({ code: 408, message: "request timed out" });
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };

    await expect(
      createJob(clients as never, "ns", { metadata: { name: "r-1", labels } }, acquisitionId),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      data: {
        providerLeaseId: "r-1",
        [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId,
      },
    });
  });

  it("does not hand off a name collision discovered during reconciliation", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce({
        metadata: {
          uid: "other-uid",
          labels: { ...labels, "paperclip.io/acquisition-id": "other-acquisition" },
        },
      });
    const create = vi.fn().mockRejectedValue({ code: 409, message: "already exists" });
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };

    const failure = await createJob(
      clients as never,
      "ns",
      { metadata: { name: "r-1", labels } },
      acquisitionId,
    ).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ message: expect.stringMatching(/ownership does not match/) });
    expect(failure).not.toHaveProperty("data");
  });
});

describe("getJobStatus", () => {
  it("returns phase=Succeeded when succeeded count is 1", async () => {
    const get = vi.fn().mockResolvedValue({ status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Succeeded");
    expect(status.complete).toBe(true);
  });

  it("returns phase=Failed when failed count is >0", async () => {
    const get = vi.fn().mockResolvedValue({ status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Failed");
    expect(status.reason).toBe("DeadlineExceeded");
  });

  it("returns phase=Running when active count is >0", async () => {
    const get = vi.fn().mockResolvedValue({ status: { active: 1 } });
    const clients = {
      batch: { readNamespacedJobStatus: get },
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: "r-1-pod" }, status: { phase: "Running" } }],
        }),
      },
    };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Running");
  });

  it("returns phase=Pending when an active Job only has Pending pods", async () => {
    const get = vi.fn().mockResolvedValue({ status: { active: 1 } });
    const clients = {
      batch: { readNamespacedJobStatus: get },
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: "r-1-pod" }, status: { phase: "Pending" } }],
        }),
      },
    };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Pending");
  });

  it("returns phase=Pending when no active/succeeded/failed counters set", async () => {
    const get = vi.fn().mockResolvedValue({ status: {} });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Pending");
  });
});

describe("findPodForJob", () => {
  it("lists pods by job-name label and returns the first running pod", async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ metadata: { name: "r-1-xyz" }, status: { phase: "Running" } }] });
    const clients = { core: { listNamespacedPod: list } };
    const podName = await findPodForJob(clients as never, "ns", "r-1");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ namespace: "ns", labelSelector: "job-name=r-1" }));
    expect(podName).toBe("r-1-xyz");
  });

  it("returns null when no pod is found", async () => {
    const list = vi.fn().mockResolvedValue({ items: [] });
    const clients = { core: { listNamespacedPod: list } };
    const podName = await findPodForJob(clients as never, "ns", "r-1");
    expect(podName).toBeNull();
  });
});

describe("deleteJob", () => {
  it("calls batch.deleteNamespacedJob with foreground propagation", async () => {
    const del = vi.fn().mockResolvedValue({});
    const clients = { batch: { deleteNamespacedJob: del } };
    await deleteJob(clients as never, "ns", "r-1");
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns",
        name: "r-1",
        propagationPolicy: "Foreground",
      }),
    );
  });
});

describe("waitForJobCompletion", () => {
  it("throws JobTimeoutError when the deadline is exceeded", async () => {
    const get = vi.fn().mockResolvedValue({ status: { active: 1 } });
    const clients = {
      batch: { readNamespacedJobStatus: get },
      core: { listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }) },
    };
    await expect(
      waitForJobCompletion(clients as never, "ns", "r-1", { timeoutMs: 50, pollMs: 10 }),
    ).rejects.toBeInstanceOf(JobTimeoutError);
  });
});
