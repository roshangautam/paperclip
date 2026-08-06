import { createHash } from "node:crypto";

// Namespace names are capped at 63 chars (RFC 1123). The default "paperclip-"
// prefix leaves 53 for the slug, which fits a full 36-char UUID untruncated.
const MAX_SLUG_LENGTH = 53;

export function deriveCompanySlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+$/, "");
  if (slug.length === 0) return "company";
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  // Never drop entropy by plain truncation: two long inputs sharing a prefix
  // (e.g. UUIDs differing only in their tail) must not map to the same slug,
  // or the tenants would share a namespace and each other's per-run Secrets.
  // Keep a readable head and append a hash of the FULL input so every byte
  // contributes to the final name.
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 8);
  return `${slug.slice(0, MAX_SLUG_LENGTH - 9).replace(/-+$/, "")}-${digest}`;
}

export function deriveNamespaceName(prefix: string, slug: string): string {
  return `${prefix}${slug}`;
}

/**
 * Derive a stable RFC 1123 resource name from the host's acquisition ID.
 *
 * The full acquisition ID remains on the resource as an ownership label; the
 * hash is only the collision-resistant Kubernetes object name. Keeping the
 * name deterministic lets a replay issue an exact GET instead of listing or
 * guessing which workload a prior, ambiguous create produced.
 */
export function deriveAcquisitionResourceName(acquisitionId: string): string {
  const digest = createHash("sha256").update(acquisitionId).digest("hex").slice(0, 32);
  return `pc-acq-${digest}`;
}

export interface LabelsInput {
  acquisitionId: string;
  runId: string;
  agentId: string;
  companyId: string;
  adapterType: string;
}

export function paperclipLabels(input: LabelsInput): Record<string, string> {
  return {
    "paperclip.io/acquisition-id": input.acquisitionId,
    "paperclip.io/run-id": input.runId,
    "paperclip.io/agent-id": input.agentId,
    "paperclip.io/company-id": input.companyId,
    "paperclip.io/adapter": input.adapterType,
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
  };
}
