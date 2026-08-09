import { and, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { environmentLeases } from "@paperclipai/db";

export const PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON =
  "provider_lease_identity_missing_manual_cleanup_required";

const newerReusableLease = alias(environmentLeases, "newer_reusable_environment_lease");

/**
 * A provider resource may have multiple historical lease rows. Only the newest
 * row owns cleanup for that physical resource. Rows without a provider lease ID
 * cannot be correlated safely, so each remains independently authoritative.
 */
export function isAuthoritativeReusableEnvironmentLease() {
  return or(
    isNull(environmentLeases.providerLeaseId),
    sql`not exists (
      select 1
      from ${environmentLeases} as ${newerReusableLease}
      where ${newerReusableLease.companyId} = ${environmentLeases.companyId}
        and ${newerReusableLease.environmentId} = ${environmentLeases.environmentId}
        and ${newerReusableLease.leasePolicy} = 'reuse_by_environment'
        and ${newerReusableLease.provider} is not distinct from ${environmentLeases.provider}
        and ${newerReusableLease.providerLeaseId} = ${environmentLeases.providerLeaseId}
        and (
          ${newerReusableLease.createdAt} > ${environmentLeases.createdAt}
          or (
            ${newerReusableLease.createdAt} = ${environmentLeases.createdAt}
            and ${newerReusableLease.id} > ${environmentLeases.id}
          )
        )
    )`,
  );
}

export function isAutomaticReusableEnvironmentLeaseCleanupCandidate() {
  return and(
    isAuthoritativeReusableEnvironmentLease(),
    sql`${environmentLeases.failureReason}
      is distinct from ${PROVIDER_LEASE_IDENTITY_MISSING_MANUAL_CLEANUP_REASON}`,
  );
}
