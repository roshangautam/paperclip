import { describe, it, expect, vi } from "vitest";
import { createPerRunSecret } from "../../src/secret-manager.js";

describe("createPerRunSecret", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    secretName: "r-abcd-env",
    acquisitionId: "acquisition-1",
    runId: "r-abcd",
    ownerKind: "Job",
    ownerApiVersion: "batch/v1",
    ownerName: "r-abcd",
    ownerUid: "11111111-1111-1111-1111-111111111111",
    bootstrapToken: "tok-xyz",
    adapterEnv: { ANTHROPIC_API_KEY: "sk-test" },
  };

  function creatingClients(created: { body: Record<string, unknown> }[]) {
    return {
      core: {
        readNamespacedSecret: vi.fn().mockRejectedValue({ code: 404 }),
        createNamespacedSecret: vi.fn(async (args: { body: Record<string, unknown> }) => {
          created.push(args);
        }),
      },
    };
  }

  function existingSecret() {
    return {
      metadata: {
        labels: {
          "paperclip.io/managed-by": "paperclip-k8s-plugin",
          "paperclip.io/acquisition-id": baseInput.acquisitionId,
        },
        ownerReferences: [{
          apiVersion: baseInput.ownerApiVersion,
          kind: baseInput.ownerKind,
          name: baseInput.ownerName,
          uid: baseInput.ownerUid,
        }],
      },
      data: { BOOTSTRAP_TOKEN: Buffer.from("original-token").toString("base64") },
    };
  }

  it("creates a Secret with the correct name and namespace", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = creatingClients(created);
    await createPerRunSecret(clients as never, baseInput);
    expect(clients.core.createNamespacedSecret).toHaveBeenCalledOnce();
    const body = created[0].body as { metadata: { name: string; namespace: string } };
    expect(body.metadata.name).toBe("r-abcd-env");
    expect(body.metadata.namespace).toBe("paperclip-acme");
  });

  it("includes BOOTSTRAP_TOKEN and adapter env keys in stringData", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = creatingClients(created);
    await createPerRunSecret(clients as never, baseInput);
    const body = created[0].body as { stringData: Record<string, string> };
    expect(body.stringData.BOOTSTRAP_TOKEN).toBe("tok-xyz");
    expect(body.stringData.ANTHROPIC_API_KEY).toBe("sk-test");
  });

  it("sets ownerReferences to the owner resource for cascade delete", async () => {
    const created: { body: Record<string, unknown> }[] = [];
    const clients = creatingClients(created);
    await createPerRunSecret(clients as never, baseInput);
    const body = created[0].body as { metadata: { ownerReferences: { uid: string; controller: boolean }[] } };
    expect(body.metadata.ownerReferences).toHaveLength(1);
    expect(body.metadata.ownerReferences[0].uid).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.metadata.ownerReferences[0].controller).toBe(true);
  });

  it("throws if adapterEnv contains BOOTSTRAP_TOKEN", async () => {
    const clients = { core: { createNamespacedSecret: vi.fn() } };
    await expect(
      createPerRunSecret(clients as never, {
        ...baseInput,
        adapterEnv: { BOOTSTRAP_TOKEN: "evil" },
      }),
    ).rejects.toThrow(/BOOTSTRAP_TOKEN/);
  });

  it("throws if ownerUid is empty", async () => {
    const clients = { core: { createNamespacedSecret: vi.fn() } };
    await expect(
      createPerRunSecret(clients as never, { ...baseInput, ownerUid: "" }),
    ).rejects.toThrow(/ownerUid/);
  });

  it("adopts an owned Secret without overwriting its bootstrap token", async () => {
    const read = vi.fn().mockResolvedValue(existingSecret());
    const create = vi.fn();
    const clients = { core: { readNamespacedSecret: read, createNamespacedSecret: create } };

    await expect(
      createPerRunSecret(clients as never, { ...baseInput, bootstrapToken: "new-token" }),
    ).resolves.toEqual({ created: false });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a Secret whose owner UID does not match the acquired workload", async () => {
    const secret = existingSecret();
    secret.metadata.ownerReferences[0].uid = "other-uid";
    const clients = {
      core: {
        readNamespacedSecret: vi.fn().mockResolvedValue(secret),
        createNamespacedSecret: vi.fn(),
      },
    };

    await expect(createPerRunSecret(clients as never, baseInput)).rejects.toThrow(
      /owner does not match/,
    );
    expect(clients.core.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous create without replacing the committed Secret", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce({ code: 404 })
      .mockResolvedValueOnce(existingSecret());
    const create = vi.fn().mockRejectedValue(new Error("response lost"));
    const clients = { core: { readNamespacedSecret: read, createNamespacedSecret: create } };

    await expect(createPerRunSecret(clients as never, baseInput)).resolves.toEqual({
      created: false,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
