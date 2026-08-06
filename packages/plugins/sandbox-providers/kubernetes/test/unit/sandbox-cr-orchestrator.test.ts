import {
  PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY,
  PLUGIN_RPC_ERROR_CODES,
} from "@paperclipai/plugin-sdk";
import { describe, it, expect, vi } from "vitest";
import {
  createSandboxCr,
  deleteSandboxCr,
  getSandboxCrStatus,
  findPodForSandbox,
  SandboxCrTimeoutError,
  waitForSandboxReady,
} from "../../src/sandbox-cr-orchestrator.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1alpha1";
const SANDBOX_PLURAL = "sandboxes";

// Helpers to build mock CR objects with given phase
function makeCr(phase: string, podName?: string): Record<string, unknown> {
  return {
    metadata: { uid: "sandbox-uid-123" },
    status: {
      phase,
      ...(podName ? { podName } : {}),
    },
  };
}

describe("createSandboxCr", () => {
  const acquisitionId = "acquisition-1";
  const labels = {
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
    "paperclip.io/acquisition-id": acquisitionId,
  };

  it("calls custom.createNamespacedCustomObject with the correct params", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "test-uid" } });
    const get = vi.fn().mockRejectedValue({ code: 404 });
    const clients = { custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get } };
    const manifest = {
      apiVersion: "agents.x-k8s.io/v1alpha1",
      kind: "Sandbox",
      metadata: { name: "pc-abc", namespace: "paperclip-acme", labels },
    };
    const result = await createSandboxCr(clients as never, "paperclip-acme", manifest, acquisitionId);
    expect(get).toHaveBeenCalledWith({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: "paperclip-acme",
      plural: SANDBOX_PLURAL,
      name: "pc-abc",
    });
    expect(create).toHaveBeenCalledWith({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: "paperclip-acme",
      plural: SANDBOX_PLURAL,
      body: manifest,
    });
    expect(result.uid).toBe("test-uid");
    expect(result.created).toBe(true);
  });

  it("throws if the API response has no UID", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: {} });
    const get = vi.fn().mockRejectedValue({ code: 404 });
    const clients = { custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get } };
    await expect(
      createSandboxCr(clients as never, "ns", { metadata: { name: "pc-abc", labels } }, acquisitionId),
    ).rejects.toThrow("Sandbox CR created without a UID");
  });

  it("adopts an existing exactly-owned Sandbox without creating another", async () => {
    const get = vi.fn().mockResolvedValue({ metadata: { uid: "existing-uid", labels } });
    const create = vi.fn();
    const clients = { custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get } };

    await expect(
      createSandboxCr(
        clients as never,
        "ns",
        { metadata: { name: "pc-abc", labels } },
        acquisitionId,
      ),
    ).resolves.toEqual({ uid: "existing-uid", created: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a deterministic-name collision owned by another acquisition", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: {
        uid: "other-uid",
        labels: { ...labels, "paperclip.io/acquisition-id": "other-acquisition" },
      },
    });
    const create = vi.fn();
    const clients = { custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get } };

    await expect(
      createSandboxCr(
        clients as never,
        "ns",
        { metadata: { name: "pc-abc", labels } },
        acquisitionId,
      ),
    ).rejects.toThrow(/ownership does not match/);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not hand off a lease before create when the initial ownership read fails", async () => {
    const get = vi.fn().mockRejectedValue(new Error("API unavailable"));
    const create = vi.fn();
    const clients = {
      custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get },
    };

    const failure = await createSandboxCr(
      clients as never,
      "ns",
      { metadata: { name: "pc-abc", labels } },
      acquisitionId,
    ).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ message: "API unavailable" });
    expect(failure).not.toHaveProperty("data");
    expect(create).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous create error by exact name and ownership", async () => {
    const get = vi.fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce({ metadata: { uid: "committed-uid", labels } });
    const create = vi.fn().mockRejectedValue(new Error("response lost"));
    const clients = { custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get } };

    await expect(
      createSandboxCr(
        clients as never,
        "ns",
        { metadata: { name: "pc-abc", labels } },
        acquisitionId,
      ),
    ).resolves.toEqual({ uid: "committed-uid", created: false });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("preserves the deterministic lease id when an ambiguous create is not visible yet", async () => {
    const get = vi.fn().mockRejectedValue({ code: 404 });
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error("response lost"), { code: "ECONNRESET" }),
    );
    const clients = { custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get } };

    await expect(
      createSandboxCr(
        clients as never,
        "ns",
        { metadata: { name: "pc-abc", labels } },
        acquisitionId,
      ),
    ).rejects.toMatchObject({
      name: "JsonRpcCallError",
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      message: "response lost",
      data: {
        providerLeaseId: "pc-abc",
        [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId,
      },
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("preserves the deterministic lease id when reconciliation itself fails", async () => {
    const get = vi.fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockRejectedValueOnce({ code: 503 });
    const create = vi.fn().mockRejectedValue({ code: 408, message: "request timed out" });
    const clients = { custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get } };

    await expect(
      createSandboxCr(
        clients as never,
        "ns",
        { metadata: { name: "pc-abc", labels } },
        acquisitionId,
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
      data: {
        providerLeaseId: "pc-abc",
        [PLUGIN_ENVIRONMENT_CLEANUP_VERIFIED_ACQUISITION_ID_KEY]: acquisitionId,
      },
    });
  });

  it("does not hand off a name collision discovered during reconciliation", async () => {
    const get = vi.fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce({
        metadata: {
          uid: "other-uid",
          labels: { ...labels, "paperclip.io/acquisition-id": "other-acquisition" },
        },
      });
    const create = vi.fn().mockRejectedValue({ code: 409, message: "already exists" });
    const clients = { custom: { createNamespacedCustomObject: create, getNamespacedCustomObject: get } };

    const failure = await createSandboxCr(
      clients as never,
      "ns",
      { metadata: { name: "pc-abc", labels } },
      acquisitionId,
    ).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ message: expect.stringMatching(/ownership does not match/) });
    expect(failure).not.toHaveProperty("data");
  });
});

describe("getSandboxCrStatus", () => {
  it("maps phase=Ready to SandboxStatus.phase=Running with active=1", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Running");
    expect(status.active).toBe(1);
    expect(status.complete).toBe(false);
  });

  it("maps a conditions-only Ready Sandbox to Running", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "uid-1" },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Running");
    expect(status.active).toBe(1);
  });

  it("maps phase=Pending to SandboxStatus.phase=Pending", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Pending");
    expect(status.active).toBe(0);
  });

  it("maps phase=Failed to SandboxStatus.phase=Failed with failed=1", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "uid-1" },
      status: {
        phase: "Failed",
        conditions: [
          { type: "Failed", reason: "ImagePullFailed", message: "no image" },
        ],
      },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Failed");
    expect(status.failed).toBe(1);
    expect(status.reason).toBe("ImagePullFailed");
  });

  it("maps a conditions-only Failed Sandbox to Failed", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "uid-1" },
      status: {
        conditions: [
          { type: "Failed", status: "True", reason: "ImagePullFailed", message: "no image" },
        ],
      },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Failed");
    expect(status.reason).toBe("ImagePullFailed");
  });

  it("maps phase=Terminating to SandboxStatus.phase=Running with reason=Terminating", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Terminating"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await getSandboxCrStatus(clients as never, "ns", "pc-abc");
    expect(status.phase).toBe("Running");
    expect(status.reason).toBe("Terminating");
  });
});

describe("findPodForSandbox", () => {
  it("returns status.podName from the Sandbox CR when set", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready", "pc-abc-pod-xyz"));
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: vi.fn(), listNamespacedPod: vi.fn() },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(podName).toBe("pc-abc-pod-xyz");
    // Primary path succeeded: neither the exact-name GET nor the label list runs.
    expect(clients.core.readNamespacedPod).not.toHaveBeenCalled();
    expect(clients.core.listNamespacedPod).not.toHaveBeenCalled();
  });

  it("resolves the pod by EXACT NAME when the controller names it after the sandbox (v0.4.x: pods carry only agents.x-k8s.io/sandbox-name-hash, never the full-name label)", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready")); // no podName in status
    const read = vi.fn().mockResolvedValue({
      metadata: { name: "pc-abc", labels: { "agents.x-k8s.io/sandbox-name-hash": "1a2b3c" } },
      status: { phase: "Running" },
    });
    const list = vi.fn().mockResolvedValue({ items: [] }); // full-name label selector matches nothing on v0.4.x
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: read, listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(read).toHaveBeenCalledWith({ namespace: "ns", name: "pc-abc" });
    expect(podName).toBe("pc-abc");
    expect(list).not.toHaveBeenCalled();
  });

  it("falls back to pod listing scoped by the unique sandbox-name label", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending")); // no podName
    const read = vi.fn().mockRejectedValue({ code: 404 }); // no exact-name pod
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          metadata: { name: "pc-abc-001", labels: { "agents.x-k8s.io/sandbox-name": "pc-abc" } },
          status: { phase: "Running" },
        },
      ],
    });
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: read, listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ labelSelector: "agents.x-k8s.io/sandbox-name=pc-abc" }),
    );
    expect(podName).toBe("pc-abc-001");
  });

  it("never matches another sandbox's pod by name prefix", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const list = vi.fn().mockResolvedValue({
      items: [
        {
          // Same name prefix, different sandbox label: must NOT match.
          metadata: { name: "pc-abc-zzz", labels: { "agents.x-k8s.io/sandbox-name": "pc-abc-zzz" } },
          status: { phase: "Running" },
        },
      ],
    });
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: vi.fn().mockRejectedValue({ code: 404 }), listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(podName).toBeNull();
  });

  it("propagates non-404 errors from the exact-name pod GET instead of falling through", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const read = vi.fn().mockRejectedValue({ code: 403, message: "forbidden" });
    const list = vi.fn();
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: read, listNamespacedPod: list },
    };
    await expect(findPodForSandbox(clients as never, "ns", "pc-abc")).rejects.toMatchObject({
      code: 403,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("returns null when no pod is found in fallback", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const list = vi.fn().mockResolvedValue({ items: [] });
    const clients = {
      custom: { getNamespacedCustomObject: get },
      core: { readNamespacedPod: vi.fn().mockRejectedValue({ code: 404 }), listNamespacedPod: list },
    };
    const podName = await findPodForSandbox(clients as never, "ns", "pc-abc");
    expect(podName).toBeNull();
  });
});

describe("deleteSandboxCr", () => {
  it("calls custom.deleteNamespacedCustomObject with Foreground propagation", async () => {
    const del = vi.fn().mockResolvedValue({});
    const clients = { custom: { deleteNamespacedCustomObject: del } };
    await deleteSandboxCr(clients as never, "ns", "pc-abc");
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: "ns",
        plural: SANDBOX_PLURAL,
        name: "pc-abc",
        propagationPolicy: "Foreground",
      }),
    );
  });
});

describe("waitForSandboxReady", () => {
  it("resolves immediately when Sandbox is already Ready", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await waitForSandboxReady(
      clients as never,
      "ns",
      "pc-abc",
      { timeoutMs: 5000, pollMs: 10 },
    );
    expect(status.phase).toBe("Running"); // Ready maps to Running
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("polls until Ready", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(makeCr("Pending"))
      .mockResolvedValueOnce(makeCr("Pending"))
      .mockResolvedValueOnce(makeCr("Ready"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    const status = await waitForSandboxReady(
      clients as never,
      "ns",
      "pc-abc",
      { timeoutMs: 5000, pollMs: 10 },
    );
    expect(status.phase).toBe("Running");
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("throws SandboxCrTimeoutError when deadline is exceeded", async () => {
    const get = vi.fn().mockResolvedValue(makeCr("Pending"));
    const clients = { custom: { getNamespacedCustomObject: get } };
    await expect(
      waitForSandboxReady(clients as never, "ns", "pc-abc", {
        timeoutMs: 50,
        pollMs: 10,
      }),
    ).rejects.toBeInstanceOf(SandboxCrTimeoutError);
  });

  it("throws an error describing the failure when Sandbox fails", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { uid: "u1" },
      status: { phase: "Failed", conditions: [{ type: "Failed", reason: "OOMKilled" }] },
    });
    const clients = { custom: { getNamespacedCustomObject: get } };
    await expect(
      waitForSandboxReady(clients as never, "ns", "pc-abc", {
        timeoutMs: 5000,
        pollMs: 10,
      }),
    ).rejects.toThrow(/failed.*OOMKilled/i);
  });
});
