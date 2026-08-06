import type { KubeClients } from "./kube-client.js";
import {
  AcquisitionOwnershipMismatchError,
  acquisitionFailureWithLease,
  isAmbiguousCreateError,
  kubeStatusCode,
  type SandboxClaimResult,
  type SandboxOrchestrator,
  type SandboxStatus,
} from "./sandbox-orchestrator.js";

const MANAGED_BY = "paperclip-k8s-plugin";

function jobNameFromManifest(manifest: Record<string, unknown>): string {
  const metadata = manifest.metadata as { name?: unknown } | undefined;
  if (typeof metadata?.name !== "string" || metadata.name.length === 0) {
    throw new Error("Job manifest requires metadata.name");
  }
  return metadata.name;
}

function validateAcquiredJob(
  job: unknown,
  name: string,
  acquisitionId: string,
): SandboxClaimResult {
  const metadata = (job as {
    metadata?: { uid?: unknown; labels?: Record<string, string> };
  } | null)?.metadata;
  if (
    metadata?.labels?.["paperclip.io/managed-by"] !== MANAGED_BY
    || metadata.labels["paperclip.io/acquisition-id"] !== acquisitionId
  ) {
    throw new AcquisitionOwnershipMismatchError(
      `Refusing to adopt Kubernetes Job ${name}: acquisition ownership does not match ${acquisitionId}.`,
    );
  }
  if (typeof metadata.uid !== "string" || metadata.uid.length === 0) {
    throw new Error(`Kubernetes Job ${name} has no UID`);
  }
  return { uid: metadata.uid, created: false };
}

async function readAcquiredJob(
  clients: KubeClients,
  namespace: string,
  name: string,
  acquisitionId: string,
): Promise<SandboxClaimResult | null> {
  try {
    const job = await clients.batch.readNamespacedJob({ namespace, name });
    return validateAcquiredJob(job, name, acquisitionId);
  } catch (error) {
    if (kubeStatusCode(error) === 404) return null;
    throw error;
  }
}

export class JobTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(`Job ${namespace}/${name} did not complete within ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

export async function createJob(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
  acquisitionId: string,
): Promise<SandboxClaimResult> {
  const name = jobNameFromManifest(manifest);
  const existing = await readAcquiredJob(clients, namespace, name, acquisitionId);
  if (existing) return existing;

  try {
    const result = await clients.batch.createNamespacedJob({ namespace, body: manifest as never });
    const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
    if (!uid) throw new Error("Job created without a UID");
    return { uid, created: true };
  } catch (createError) {
    // A timeout/409 can mean the API server committed the create but the
    // response was lost. Re-read the exact deterministic name once and adopt
    // only if both Paperclip ownership labels match.
    try {
      const reconciled = await readAcquiredJob(clients, namespace, name, acquisitionId);
      if (reconciled) return reconciled;
    } catch (reconcileError) {
      if (reconcileError instanceof AcquisitionOwnershipMismatchError) throw reconcileError;
      if (isAmbiguousCreateError(createError)) {
        throw acquisitionFailureWithLease(createError, name, acquisitionId);
      }
      throw reconcileError;
    }
    if (isAmbiguousCreateError(createError)) {
      throw acquisitionFailureWithLease(createError, name, acquisitionId);
    }
    throw createError;
  }
}

export type JobStatus = SandboxStatus;

export async function getJobStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<JobStatus> {
  const result = await clients.batch.readNamespacedJobStatus({ namespace, name });
  const body = (result as Record<string, unknown>) ?? {};
  const status = (body.status as Record<string, unknown>) ?? {};
  const active = (status.active as number) ?? 0;
  const succeeded = (status.succeeded as number) ?? 0;
  const failed = (status.failed as number) ?? 0;
  const conditions = (status.conditions as { type: string; status: string; reason?: string; message?: string }[]) ?? [];
  const completed = conditions.find((c) => c.type === "Complete" && c.status === "True");
  const failedCond = conditions.find((c) => c.type === "Failed" && c.status === "True");
  if (failedCond || failed > 0) {
    return { phase: "Failed", complete: false, active, succeeded, failed, reason: failedCond?.reason, message: failedCond?.message };
  }
  if (completed || succeeded > 0) {
    return { phase: "Succeeded", complete: true, active, succeeded, failed };
  }
  if (active > 0) {
    const pods = await listPodsForJob(clients, namespace, name);
    if (pods.some((pod) => pod.status?.phase === "Running")) {
      return { phase: "Running", complete: false, active, succeeded, failed };
    }
    if (!pods.some((pod) => pod.status?.phase === "Pending")) {
      return { phase: "Running", complete: false, active, succeeded, failed };
    }
  }
  return { phase: "Pending", complete: false, active, succeeded, failed };
}

type JobPod = { metadata?: { name?: string }; status?: { phase?: string } };

async function listPodsForJob(
  clients: KubeClients,
  namespace: string,
  jobName: string,
): Promise<JobPod[]> {
  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
  });
  return ((result as { items?: JobPod[] }).items) ?? [];
}

export async function findPodForJob(
  clients: KubeClients,
  namespace: string,
  jobName: string,
): Promise<string | null> {
  const items = await listPodsForJob(clients, namespace, jobName);
  const running = items.find((p) => p.status?.phase === "Running");
  return (running ?? items[0])?.metadata?.name ?? null;
}

export async function streamPodLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  // V1 limitation: readNamespacedPodLog returns combined stdout (the kubectl-style
  // log view). stderr is not separately exposed via this API path — agent
  // containers that need stderr/stdout separation should use a sidecar log
  // scraper or wrap their CLI to emit structured output on stdout. We always
  // emit chunks as "stdout"; the "stderr" callback slot in SandboxOrchestrator
  // is unused by the Job-backed implementation.
  const result = await clients.core.readNamespacedPodLog({ namespace, name: podName });
  const text = (result as string) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteJob(
  clients: KubeClients,
  namespace: string,
  name: string,
  uid?: string,
): Promise<void> {
  await clients.batch.deleteNamespacedJob({
    namespace,
    name,
    propagationPolicy: "Foreground",
    ...(uid ? { body: { preconditions: { uid } } } : {}),
  });
}

export async function waitForJobCompletion(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number } = { timeoutMs: 120_000, pollMs: 2000 },
): Promise<JobStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;
  while (Date.now() < deadline) {
    const status = await getJobStatus(clients, namespace, name);
    if (status.phase === "Succeeded" || status.phase === "Failed") return status;
    await sleep(pollMs);
  }
  throw new JobTimeoutError(namespace, name, opts.timeoutMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Job-backed conformance to SandboxOrchestrator. Plugin.ts imports THIS value
 * (the swap point) — to use a different backend, swap this import for another
 * module exposing a SandboxOrchestrator-shaped default export.
 */
export const jobOrchestrator: SandboxOrchestrator = {
  claim: createJob,
  getStatus: getJobStatus,
  findPod: findPodForJob,
  streamLogs: streamPodLogs,
  release: deleteJob,
  waitForCompletion: waitForJobCompletion,
};
