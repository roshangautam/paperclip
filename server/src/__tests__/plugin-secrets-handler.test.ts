import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySecretVersions,
  createDb,
  plugins,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  createPluginSecretsHandler,
  extractSecretRefBindingsFromConfig,
} from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";

const pluginId = "11111111-1111-4111-8111-111111111111";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secret handler integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("extractSecretRefBindingsFromConfig", () => {
  it("ignores UUID strings outside schema-declared secret fields", () => {
    const externalProjectId = "77777777-7777-4777-8777-777777777777";

    expect(extractSecretRefBindingsFromConfig(
      { externalProjectId },
      { type: "object", properties: { externalProjectId: { type: "string" } } },
    )).toEqual([]);
  });

  it("rejects legacy UUID strings at schema-declared secret fields", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";

    expect(() => extractSecretRefBindingsFromConfig(
      { token: secretId },
      { type: "object", properties: { token: { format: "secret-ref" } } },
    )).toThrow(/must use.*secret_ref/i);
  });
  it("resolves anchors, percent-encoded pointers, and pattern properties", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";
    const schema = {
      type: "object",
      $defs: {
        secretRef: {
          $id: "#secret",
          format: "secret-ref",
        },
      },
      properties: {
        token: { $ref: "#secret" },
      },
      patternProperties: {
        "^dynamic_": { $ref: "#%2F$defs%2FsecretRef" },
      },
    };

    expect(() => extractSecretRefBindingsFromConfig(
      { token: "sk-live-super-secret" },
      schema,
    )).toThrow(/secret value.*must use.*secret_ref/i);
    expect(() => extractSecretRefBindingsFromConfig(
      { dynamic_api: "sk-live-super-secret" },
      schema,
    )).toThrow(/secret value.*must use.*secret_ref/i);
    expect(extractSecretRefBindingsFromConfig(
      {
        token: { type: "secret_ref", secretId },
        dynamic_api: { type: "secret_ref", secretId },
      },
      schema,
      { requireSchemaDeclaredRefs: true },
    )).toEqual([
      expect.objectContaining({ configPath: "token", secretId }),
      expect.objectContaining({ configPath: "dynamic_api", secretId }),
    ]);
    expect(() => extractSecretRefBindingsFromConfig(
      { undeclared: { type: "secret_ref", secretId } },
      schema,
      { requireSchemaDeclaredRefs: true },
    )).toThrow(/must be declared with format "secret-ref"/i);
  });

  it("fails closed on unsupported secret-bearing schema extensions", () => {
    expect(() => extractSecretRefBindingsFromConfig(
      { token: "sk-live-super-secret" },
      {
        type: "object",
        customSecretField: {
          format: "secret-ref",
        },
      },
    )).toThrow(/unsupported secret-ref keyword/i);
  });

  it("does not resolve schema refs through annotation values", () => {
    const secretId = "77777777-7777-4777-8777-777777777777";
    expect(() => extractSecretRefBindingsFromConfig(
      {
        token: { type: "secret_ref", secretId },
      },
      {
        type: "object",
        default: {
          $id: "#token",
          format: "secret-ref",
        },
        definitions: {
          ordinaryToken: {
            $id: "#token",
            type: "string",
          },
        },
        properties: {
          token: { $ref: "#token" },
        },
      },
      { requireSchemaDeclaredRefs: true },
    )).toThrow(/must be declared with format "secret-ref"/i);
  });

  it.each(["if", "then", "else", "not"] as const)(
    "does not treat an ordinary local ref under %s as a secret declaration",
    (keyword) => {
      expect(extractSecretRefBindingsFromConfig(
        {},
        {
          type: "object",
          $defs: {
            ordinary: { type: "string" },
          },
          [keyword]: { $ref: "#/$defs/ordinary" },
        },
      )).toEqual([]);
    },
  );

  it.each(["anyOf", "oneOf"] as const)(
    "does not treat an ordinary local ref under %s as a secret declaration",
    (keyword) => {
      expect(extractSecretRefBindingsFromConfig(
        {},
        {
          type: "object",
          $defs: {
            ordinary: { type: "string" },
          },
          [keyword]: [
            { $ref: "#/$defs/ordinary" },
            { type: "object" },
          ],
        },
      )).toEqual([]);
    },
  );

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects local schema pointers containing prototype key %s",
    (prototypeKey) => {
      const definitions = {
        [prototypeKey]: {
          secret: { format: "secret-ref" },
        },
      };

      expect(() => extractSecretRefBindingsFromConfig(
        {
          token: {
            type: "secret_ref",
            secretId: "77777777-7777-4777-8777-777777777777",
          },
        },
        {
          type: "object",
          $defs: definitions,
          properties: {
            token: { $ref: `#/$defs/${prototypeKey}/secret` },
          },
        },
        { requireSchemaDeclaredRefs: true },
      )).toThrow(/unsupported plugin config schema reference/i);
    },
  );

  it("does not resolve local schema pointers through inherited properties", () => {
    const definitions = Object.create({
      inherited: { format: "secret-ref" },
    }) as Record<string, unknown>;

    expect(() => extractSecretRefBindingsFromConfig(
      {
        token: {
          type: "secret_ref",
          secretId: "77777777-7777-4777-8777-777777777777",
        },
      },
      {
        type: "object",
        $defs: definitions,
        properties: {
          token: { $ref: "#/$defs/inherited" },
        },
      },
      { requireSchemaDeclaredRefs: true },
    )).toThrow(/unsupported plugin config schema reference/i);
  });

  it("rejects secret refs declared through ambiguous contains semantics", () => {
    expect(() => extractSecretRefBindingsFromConfig(
      {
        values: [
          "public",
          {
            type: "secret_ref",
            secretId: "77777777-7777-4777-8777-777777777777",
          },
        ],
      },
      {
        type: "object",
        properties: {
          values: {
            type: "array",
            contains: { format: "secret-ref" },
          },
        },
      },
    )).toThrow(/conditional keyword "contains"/i);
  });

  it("rejects secret refs declared in only one discriminated union branch", () => {
    expect(() => extractSecretRefBindingsFromConfig(
      {
        mode: "plain",
        token: {
          type: "secret_ref",
          secretId: "77777777-7777-4777-8777-777777777777",
        },
      },
      {
        type: "object",
        oneOf: [
          {
            properties: {
              mode: { const: "plain" },
              token: { type: "string" },
            },
          },
          {
            properties: {
              mode: { const: "secret" },
              token: { type: "string", format: "secret-ref" },
            },
          },
        ],
      },
      { requireSchemaDeclaredRefs: true },
    )).toThrow(/ambiguously declare secret refs through "oneOf"/i);
  });

  it("rejects nested schema resource scopes instead of resolving against the wrong root", () => {
    expect(() => extractSecretRefBindingsFromConfig(
      {
        nested: {
          token: {
            type: "secret_ref",
            secretId: "77777777-7777-4777-8777-777777777777",
          },
        },
      },
      {
        type: "object",
        $defs: {
          secret: { type: "string", format: "secret-ref" },
        },
        properties: {
          nested: {
            $id: "nested.json",
            type: "object",
            $defs: {
              secret: { type: "string" },
            },
            properties: {
              token: { $ref: "#/$defs/secret" },
            },
          },
        },
      },
      { requireSchemaDeclaredRefs: true },
    )).toThrow(/nested \$id resource scopes are not supported/i);
  });

  it("rejects pointers that cross nested schema resource scopes", () => {
    expect(() => extractSecretRefBindingsFromConfig(
      {
        token: {
          type: "secret_ref",
          secretId: "77777777-7777-4777-8777-777777777777",
        },
      },
      {
        type: "object",
        $defs: {
          secret: { type: "string", format: "secret-ref" },
          nested: {
            $id: "nested.json",
            type: "object",
            $defs: {
              secret: { type: "string" },
            },
            properties: {
              token: { $ref: "#/$defs/secret" },
            },
          },
        },
        properties: {
          token: { $ref: "#/$defs/nested/properties/token" },
        },
      },
      { requireSchemaDeclaredRefs: true },
    )).toThrow(/unsupported plugin config schema reference/i);
  });

});

describe("createPluginSecretsHandler fail-closed guards", () => {
  it("requires company context before touching the database", async () => {
    const db = { select: vi.fn(() => { throw new Error("db should not be touched"); }) };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ secretRef: { type: "secret_ref", secretId: randomUUID() } }),
    ).rejects.toThrow(/companyId is required/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects legacy string refs before provider resolution", async () => {
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = {
      select: vi.fn(() => ({ from })),
      insert: vi.fn(() => ({ values: writeAudit })),
    };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({
        companyId: randomUUID(),
        secretRef: randomUUID(),
        actorType: "agent",
        actorId: "spoofed-agent",
      } as Parameters<typeof handler.resolve>[0]),
    ).rejects.toThrow(/use \{ type: "secret_ref"/i);
    expect(db.select).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorType: "plugin",
      actorId: pluginId,
    }));
  });

  it("preserves the original secret-gate denial when rejection auditing fails", async () => {
    const writeAudit = vi.fn().mockRejectedValue(new Error("audit storage unavailable"));
    const db = {
      insert: vi.fn(() => ({ values: writeAudit })),
    };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });

    await expect(
      handler.resolve({ companyId: randomUUID(), secretRef: "not-a-secret-ref" }),
    ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    expect(writeAudit).toHaveBeenCalledOnce();
  });

  it("rate-limits rejection audit writes", async () => {
    const writeAudit = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn(() => ({ values: writeAudit })),
    };
    const handler = createPluginSecretsHandler({ db: db as never, pluginId });
    const companyId = randomUUID();

    for (let attempt = 0; attempt < 31; attempt += 1) {
      await expect(
        handler.resolve({ companyId, secretRef: "not-a-secret-ref" }),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });
    }

    expect(writeAudit).toHaveBeenCalledTimes(30);
  });

  it("evicts stale rate-limiter keys without timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const deleteSpy = vi.spyOn(Map.prototype, "delete");

    try {
      const writeAudit = vi.fn().mockResolvedValue(undefined);
      const db = {
        insert: vi.fn(() => ({ values: writeAudit })),
      };
      const handler = createPluginSecretsHandler({ db: db as never, pluginId });
      const staleCompanyId = randomUUID();

      await expect(
        handler.resolve({ companyId: staleCompanyId, secretRef: "not-a-secret-ref" }),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });

      vi.advanceTimersByTime(60_001);
      await expect(
        handler.resolve({ companyId: randomUUID(), secretRef: "not-a-secret-ref" }),
      ).rejects.toMatchObject({ name: "InvalidSecretRefError" });

      expect(deleteSpy).toHaveBeenCalledWith(`${staleCompanyId}:${pluginId}`);
    } finally {
      deleteSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describeEmbeddedPostgres("createPluginSecretsHandler shared vault integration", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-plugin-secrets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("plugin-secrets-handler");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `P${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedPlugin() {
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.plugin-secrets-test",
      packageName: "@paperclipai/plugin-secrets-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.plugin-secrets-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Plugin Secrets Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
  }

  it("resolves bound plugin refs through secretService and emits plugin_worker access events", async () => {
    await seedPlugin();
    const companyId = await seedCompany("Plugin Co");
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-plugin-secret",
    });
    await svc.syncSecretRefsForTarget(companyId, { targetType: "plugin", targetId: pluginId }, [
      { secretId: secret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId,
        secretRef: { type: "secret_ref", secretId: secret.id, version: "latest" },
        configPath: "  apiKey  ",
        actorType: "agent",
        actorId: "spoofed-agent",
      } as Parameters<typeof handler.resolve>[0]),
    ).resolves.toBe("resolved-plugin-secret");

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "plugin_worker",
      consumerId: pluginId,
      configPath: "apiKey",
      pluginId,
      actorType: "plugin",
      actorId: pluginId,
      outcome: "success",
      errorCode: null,
    });
  });

  it("audits an out-of-range requested version as null", async () => {
    await seedPlugin();
    const companyId = await seedCompany("Plugin Co");
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-plugin-secret",
    });
    await svc.syncSecretRefsForTarget(companyId, { targetType: "plugin", targetId: pluginId }, [
      { secretId: secret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId,
        secretRef: { type: "secret_ref", secretId: secret.id, version: 2_147_483_648 },
        configPath: "apiKey",
      }),
    ).rejects.toThrow(/not bound/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, secret.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      version: null,
      configPath: "apiKey",
      outcome: "failure",
      errorCode: "binding_missing",
    });
  });

  it("fails closed for cross-company resolve before secret provider access", async () => {
    await seedPlugin();
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignSecret = await svc.create(companyB, {
      name: `foreign-plugin-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "foreign-value",
    });
    await svc.syncSecretRefsForTarget(companyB, { targetType: "plugin", targetId: pluginId }, [
      { secretId: foreignSecret.id, configPath: "apiKey" },
    ], { replaceAll: true });

    const handler = createPluginSecretsHandler({ db, pluginId });
    await expect(
      handler.resolve({
        companyId: companyA,
        secretRef: { type: "secret_ref", secretId: foreignSecret.id, version: "latest" },
      }),
    ).rejects.toThrow(/not bound/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, foreignSecret.id));
    expect(events).toHaveLength(0);
  });
});
