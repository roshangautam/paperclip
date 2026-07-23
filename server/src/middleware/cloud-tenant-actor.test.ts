import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { resolveCloudTenantActor } from "./auth.js";

// Minimal fake Drizzle Db: records every table passed to .insert() / .delete() and
// supports the chained call shapes used by resolveCloudTenantActor (values /
// onConflictDo* / returning().then() / delete().where()) plus the empty plugin
// lookup used when a cloud tenant creates a company. The mutation chain is
// awaitable so directly-awaited statements resolve.
function createFakeDb(
  membershipRow = { companyId: "company-x", membershipRole: "owner", status: "active" },
  options: { companyInserted?: boolean; reconciliationFailures?: number } = {},
) {
  const insertedTables: unknown[] = [];
  const deletedTables: unknown[] = [];
  const selectedTables: unknown[] = [];
  let companyExists = options.companyInserted === false;
  let companyInsertionCount = 0;
  let reconciliationFailures = options.reconciliationFailures ?? 0;
  const mutationChain = (table?: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.values = () => chain;
    chain.onConflictDoUpdate = () => chain;
    chain.onConflictDoNothing = () => chain;
    chain.where = () => chain;
    chain.returning = async () => {
      if (table !== companies) return [membershipRow];
      if (companyExists) return [];
      companyExists = true;
      companyInsertionCount += 1;
      return [{ id: "company-x" }];
    };
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve);
    return chain;
  };
  const db = {
    select: () => {
      const selectChain: Record<string, unknown> = {};
      let selectedTable: unknown;
      selectChain.from = (table: unknown) => {
        selectedTable = table;
        selectedTables.push(table);
        return selectChain;
      };
      selectChain.where = async () => {
        if (selectedTable === companies && reconciliationFailures > 0) {
          reconciliationFailures -= 1;
          throw new Error("managed App reconciliation failed");
        }
        return [];
      };
      selectChain.orderBy = async () => [];
      return selectChain;
    },
    insert: (table: unknown) => {
      insertedTables.push(table);
      return mutationChain(table);
    },
    delete: (table: unknown) => {
      deletedTables.push(table);
      return mutationChain(table);
    },
    transaction: async (callback: (tx: Db) => Promise<unknown>) => {
      const companyExistsBefore = companyExists;
      try {
        return await callback(db as unknown as Db);
      } catch (error) {
        companyExists = companyExistsBefore;
        throw error;
      }
    },
  } as unknown as Db;
  return {
    db,
    insertedTables,
    deletedTables,
    selectedTables,
    getCompanyInsertionCount: () => companyInsertionCount,
  };
}

function fakeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

const VALID_HEADERS = {
  "x-paperclip-cloud-tenant-token": "test-server-token",
  "x-paperclip-cloud-user-id": "user-123",
  "x-paperclip-cloud-user-email": "Owner@Example.com",
  "x-paperclip-cloud-stack-id": "stack-abc",
  "x-paperclip-cloud-stack-role": "owner",
};

describe("resolveCloudTenantActor (shared-pool hardening)", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
  });

  it("never grants instance admin", async () => {
    const { db, insertedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(insertedTables).not.toContain(instanceUserRoles);
  });

  it("is scoped to exactly the one company from its stack", async () => {
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor!.companyIds).toHaveLength(1);
    expect(actor!.memberships).toHaveLength(1);
    expect(actor?.memberships?.[0]?.companyId).toBe(actor?.companyIds?.[0]);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("owner");
    expect(actor!.source).toBe("cloud_tenant");
  });

  it("purges stale instance_admin rows left by pre-hardening deployments", async () => {
    const { db, deletedTables } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).not.toBeNull();
    expect(deletedTables).toContain(instanceUserRoles);
  });

  it("still upserts the user, company, and membership", async () => {
    const { db, insertedTables } = createFakeDb();
    await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(insertedTables).toContain(authUsers);
    expect(insertedTables).toContain(companies);
    expect(insertedTables).toContain(companyMemberships);
  });

  it("reconciles plugin applications when provisioning a new company", async () => {
    const { db, selectedTables } = createFakeDb();
    await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(selectedTables).toContain(companies);
  });

  it("does not reconcile plugin applications on repeat authentication", async () => {
    const { db, selectedTables } = createFakeDb(undefined, { companyInserted: false });
    await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(selectedTables).not.toContain(companies);
  });

  it("retries complete company provisioning after reconciliation fails", async () => {
    const { db, selectedTables, getCompanyInsertionCount } = createFakeDb(undefined, {
      reconciliationFailures: 1,
    });

    await expect(resolveCloudTenantActor(db, fakeReq(VALID_HEADERS)))
      .rejects.toThrow("managed App reconciliation failed");
    await expect(resolveCloudTenantActor(db, fakeReq(VALID_HEADERS)))
      .resolves.toMatchObject({ source: "cloud_tenant" });

    expect(getCompanyInsertionCount()).toBe(2);
    expect(selectedTables.filter((table) => table === companies)).toHaveLength(2);
  });

  it("returns null when the server token is unset", async () => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    const { db } = createFakeDb();
    const actor = await resolveCloudTenantActor(db, fakeReq(VALID_HEADERS));
    expect(actor).toBeNull();
  });

  it("maps a non-owner stack role through to the membership without elevating", async () => {
    const { db } = createFakeDb({ companyId: "company-y", membershipRole: "member", status: "active" });
    const actor = await resolveCloudTenantActor(
      db,
      fakeReq({ ...VALID_HEADERS, "x-paperclip-cloud-stack-role": "member" }),
    );
    expect(actor!.isInstanceAdmin).toBe(false);
    expect(actor?.memberships?.[0]?.membershipRole).toBe("member");
  });
});
