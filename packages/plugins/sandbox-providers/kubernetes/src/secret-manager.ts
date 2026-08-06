import type { KubeClients } from "./kube-client.js";

export interface CreatePerRunSecretInput {
  namespace: string;
  secretName: string;
  acquisitionId: string;
  runId: string;
  ownerKind: string;
  ownerApiVersion: string;
  ownerName: string;
  ownerUid: string;
  bootstrapToken: string;
  adapterEnv: Record<string, string>;
  createIfMissing?: boolean;
}

const MANAGED_BY = "paperclip-k8s-plugin";

function statusCode(error: unknown): number | undefined {
  return (error as { code?: number; statusCode?: number } | null)?.code
    ?? (error as { code?: number; statusCode?: number } | null)?.statusCode;
}

function validateExistingSecret(
  secret: unknown,
  input: CreatePerRunSecretInput,
): void {
  const typed = secret as {
    metadata?: {
      labels?: Record<string, string>;
      ownerReferences?: Array<{
        apiVersion?: string;
        kind?: string;
        name?: string;
        uid?: string;
        controller?: boolean;
        blockOwnerDeletion?: boolean;
      }>;
    };
    data?: Record<string, string>;
  } | null;
  const labels = typed?.metadata?.labels ?? {};
  if (
    labels["paperclip.io/managed-by"] !== MANAGED_BY
    || labels["paperclip.io/acquisition-id"] !== input.acquisitionId
  ) {
    throw new Error(
      `Refusing to adopt Kubernetes Secret ${input.secretName}: acquisition ownership does not match ${input.acquisitionId}.`,
    );
  }
  const ownerReferences = typed?.metadata?.ownerReferences ?? [];
  const owner = ownerReferences[0];
  if (
    ownerReferences.length !== 1
    || owner?.apiVersion !== input.ownerApiVersion
    || owner.kind !== input.ownerKind
    || owner.name !== input.ownerName
    || owner.uid !== input.ownerUid
    || owner.controller !== true
    || owner.blockOwnerDeletion !== true
  ) {
    throw new Error(
      `Refusing to adopt Kubernetes Secret ${input.secretName}: owner does not match ${input.ownerKind} ${input.ownerName} (${input.ownerUid}).`,
    );
  }
  if (typeof typed?.data?.BOOTSTRAP_TOKEN !== "string" || typed.data.BOOTSTRAP_TOKEN.length === 0) {
    throw new Error(
      `Refusing to adopt Kubernetes Secret ${input.secretName}: BOOTSTRAP_TOKEN is missing.`,
    );
  }
}

async function readExistingSecret(
  clients: KubeClients,
  input: CreatePerRunSecretInput,
): Promise<boolean> {
  try {
    const secret = await clients.core.readNamespacedSecret({
      namespace: input.namespace,
      name: input.secretName,
    });
    validateExistingSecret(secret, input);
    return true;
  } catch (error) {
    if (statusCode(error) === 404) return false;
    throw error;
  }
}

export async function createPerRunSecret(
  clients: KubeClients,
  input: CreatePerRunSecretInput,
): Promise<void> {
  if (!input.ownerUid) {
    throw new Error("createPerRunSecret requires a non-empty ownerUid");
  }
  if ("BOOTSTRAP_TOKEN" in input.adapterEnv) {
    throw new Error("adapterEnv must not contain BOOTSTRAP_TOKEN (reserved key)");
  }
  const existing = await readExistingSecret(clients, input);
  if (existing) return;
  if (input.createIfMissing === false) {
    throw new Error(
      `Refusing to recreate missing Kubernetes Secret ${input.secretName} for an adopted workload.`,
    );
  }

  const body = {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: input.secretName,
        namespace: input.namespace,
        labels: {
          "paperclip.io/acquisition-id": input.acquisitionId,
          "paperclip.io/run-id": input.runId,
          "paperclip.io/managed-by": "paperclip-k8s-plugin",
        },
        ownerReferences: [
          {
            apiVersion: input.ownerApiVersion,
            kind: input.ownerKind,
            name: input.ownerName,
            uid: input.ownerUid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      stringData: {
        BOOTSTRAP_TOKEN: input.bootstrapToken,
        ...input.adapterEnv,
      },
    };

  try {
    await clients.core.createNamespacedSecret({
      namespace: input.namespace,
      body,
    });
  } catch (createError) {
    // Never patch or replace a Secret after an ambiguous create. The original
    // bootstrap token must survive replay, so reconcile by exact name and
    // validate ownership instead.
    const reconciled = await readExistingSecret(clients, input);
    if (reconciled) return;
    throw createError;
  }
}
