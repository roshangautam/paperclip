import { and, eq, isNull, or, sql } from "drizzle-orm";
import { environmentLeases } from "@paperclipai/db";

export const PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON =
  "provider_lease_identity_missing_manual_cleanup_required";

export function isAuthoritativeReusableEnvironmentLease() {
  return and(
    eq(environmentLeases.reusableResourceOwner, true),
    isNull(environmentLeases.reusableAdoptionClaimId),
  );
}

export function isReusableEnvironmentLeaseDestroyRequestCandidate() {
  return and(
    or(
      isNull(environmentLeases.providerLeaseId),
      eq(environmentLeases.reusableResourceOwner, true),
    ),
    sql`${environmentLeases.failureReason}
      is distinct from ${PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON}`,
  );
}

export function isAutomaticReusableEnvironmentLeaseCleanupCandidate() {
  return and(
    or(
      isNull(environmentLeases.providerLeaseId),
      isAuthoritativeReusableEnvironmentLease(),
    ),
    sql`${environmentLeases.failureReason}
      is distinct from ${PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON}`,
  );
}
