import {
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
} from "@paperclipai/plugin-sdk";
import type { KubeClients } from "./kube-client.js";

export class AcquisitionOwnershipMismatchError extends Error {}

export function kubeStatusCode(error: unknown): number | undefined {
  const candidate = error as { code?: unknown; statusCode?: unknown } | null;
  if (typeof candidate?.code === "number" && Number.isFinite(candidate.code)) {
    return candidate.code;
  }
  return typeof candidate?.statusCode === "number" && Number.isFinite(candidate.statusCode)
    ? candidate.statusCode
    : undefined;
}

export function isAmbiguousCreateError(error: unknown): boolean {
  const code = kubeStatusCode(error);
  return code === undefined || code === 408 || code === 409 || code === 429 || code >= 500;
}

export function acquisitionFailureWithLease(
  error: unknown,
  providerLeaseId: string,
): JsonRpcCallError {
  return new JsonRpcCallError({
    code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
    message: error instanceof Error ? error.message : String(error),
    data: { providerLeaseId },
  });
}

export interface SandboxStatus {
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
  complete: boolean;
  active: number;
  succeeded: number;
  failed: number;
  reason?: string;
  message?: string;
}

export interface SandboxClaimResult {
  uid: string;
  /** True only when this invocation received a successful create response. */
  created: boolean;
}

/**
 * Abstract interface over a sandbox runtime backend. The current implementation
 * is Job-backed (job-orchestrator.ts). Future backends slot in by exporting an
 * object conforming to this shape — e.g. a Kata-FC warm-pool backend that
 * additionally implements the optional pause/resume slots, or a CRD-backed
 * backend on kubernetes-sigs/agent-sandbox once it reaches Beta.
 */
export interface SandboxOrchestrator {
  /** Provision the sandbox. Returns the runtime's stable UID. */
  claim(
    clients: KubeClients,
    namespace: string,
    manifest: Record<string, unknown>,
    acquisitionId: string,
  ): Promise<SandboxClaimResult>;

  /** Read current lifecycle phase. */
  getStatus(
    clients: KubeClients,
    namespace: string,
    name: string,
  ): Promise<SandboxStatus>;

  /** Locate the pod backing this sandbox (or null if none exists yet). */
  findPod(
    clients: KubeClients,
    namespace: string,
    name: string,
  ): Promise<string | null>;

  /** Read logs from the sandbox's pod. V1: post-completion read. */
  streamLogs(
    clients: KubeClients,
    namespace: string,
    podName: string,
    onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
  ): Promise<void>;

  /** Tear down the sandbox. Implementations MUST cascade-delete child resources. */
  release(
    clients: KubeClients,
    namespace: string,
    name: string,
    uid?: string,
  ): Promise<void>;

  /** Block until phase is Succeeded or Failed, or throw on timeout. */
  waitForCompletion(
    clients: KubeClients,
    namespace: string,
    name: string,
    opts: { timeoutMs: number; pollMs?: number },
  ): Promise<SandboxStatus>;

  // Optional warm-pool / Kata-FC extension slots. Job-backed implementation
  // does not provide these; runtimes that do (e.g. Kata-FC microVM pause)
  // implement them and acquire the warm-pool capability.
  // TODO: requires custom in-cluster controller for k8s — kubelet does not
  // expose pause/resume at the pod level. Add when warm-pool design lands.
  pause?(clients: KubeClients, namespace: string, name: string): Promise<void>;
  resume?(clients: KubeClients, namespace: string, name: string): Promise<void>;
}
