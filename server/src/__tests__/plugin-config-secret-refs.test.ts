import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  pluginConfig,
  plugins,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db/test-embedded-postgres";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginConfigSecretRefPatcher } from "../services/plugin-config-secret-refs.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin secret-ref config tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

let fixtureCounter = 0;

function createManifest(
  pluginKey: string,
  instanceConfigSchema?: PaperclipPluginManifestV1["instanceConfigSchema"],
): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Secret Config Test",
    description: "Exercises governed plugin secret-ref config patching.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["secrets.bind-ref"],
    entrypoints: {},
    instanceConfigSchema,
  };
}

describeEmbeddedPostgres("plugin config secret refs", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-secret-config-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createFixture(
    instanceConfigSchema?: PaperclipPluginManifestV1["instanceConfigSchema"],
  ) {
    fixtureCounter += 1;
    const suffix = fixtureCounter.toString(36);
    const [company] = await db
      .insert(companies)
      .values({
        name: `Plugin Secret Config ${suffix}`,
        issuePrefix: `S${suffix.toUpperCase()}`,
      })
      .returning();
    const pluginKey = `paperclip.secret-config-${suffix}`;
    const manifest = createManifest(pluginKey, instanceConfigSchema);
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey,
        packageName: `@paperclipai/secret-config-${suffix}`,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        categories: manifest.categories,
        manifestJson: manifest,
        status: "ready",
        installOrder: fixtureCounter,
      })
      .returning();
    return {
      company,
      plugin,
      manifest,
      patch: createPluginConfigSecretRefPatcher({
        db,
        pluginId: plugin.id,
        pluginKey,
      }),
    };
  }

  async function createSecret(
    companyId: string,
    options: {
      status?: string;
      version?: number;
      versionStatus?: string;
      revokedAt?: Date | null;
    } = {},
  ) {
    fixtureCounter += 1;
    const suffix = fixtureCounter.toString(36);
    const version = options.version ?? 1;
    const [secret] = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: `SECRET_${suffix.toUpperCase()}`,
        name: `Secret ${suffix}`,
        scope: "company",
        status: options.status ?? "active",
        latestVersion: version,
      })
      .returning();
    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version,
      material: { test: true },
      valueSha256: `value-${suffix}`,
      fingerprintSha256: `fingerprint-${suffix}`,
      status: options.versionStatus ?? "current",
      revokedAt: options.revokedAt ?? null,
    });
    return secret;
  }

  async function seedConfig(
    pluginId: string,
    companyId: string,
    configJson: Record<string, unknown>,
  ) {
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson });
  }

  async function seedBinding(
    pluginId: string,
    companyId: string,
    secretId: string,
    configPath: string,
    versionSelector = "latest",
  ) {
    await db.insert(companySecretBindings).values({
      companyId,
      secretId,
      targetType: "plugin",
      targetId: pluginId,
      configPath,
      versionSelector,
      required: true,
      label: configPath,
    });
  }

  it("creates config, exact bindings, and an audit record for paths containing SQL wildcards", async () => {
    const fixture = await createFixture();
    const secret = await createSecret(fixture.company.id);
    const secretRef = {
      type: "secret_ref" as const,
      secretId: secret.id,
      projectionClass: "class_3_static_lease" as const,
      projectionAllowlistKey: "plugin-config-test",
    };

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials%", "api_key"],
      value: { token_ref: secretRef },
    })).resolves.toEqual({
      "credentials%": {
        api_key: {
          token_ref: secretRef,
        },
      },
    });

    const storedBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, fixture.company.id),
        eq(companySecretBindings.targetId, fixture.plugin.id),
      ));
    expect(storedBindings).toHaveLength(1);
    expect(storedBindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "credentials%.api_key.token_ref",
      versionSelector: "latest",
      projectionClass: "class_3_static_lease",
      projectionAllowlistKey: "plugin-config-test",
    });

    const audit = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, fixture.company.id),
        eq(activityLog.action, "plugin.config.secret_refs_patched"),
      ))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      actorType: "plugin",
      actorId: fixture.plugin.id,
      entityId: fixture.plugin.id,
      details: {
        configPath: "credentials%.api_key",
        boundSecretCount: 1,
        removedSecretCount: 0,
        sourcePluginId: fixture.plugin.id,
        sourcePluginKey: fixture.manifest.id,
      },
    });
  });

  it("atomically replaces full config and bindings through the registry", async () => {
    const fixture = await createFixture();
    const secret = await createSecret(fixture.company.id);
    const foreignFixture = await createFixture();
    const foreignSecret = await createSecret(foreignFixture.company.id);
    const registry = pluginRegistryService(db);
    const secretRef = { type: "secret_ref" as const, secretId: secret.id };

    await registry.upsertConfig(fixture.plugin.id, fixture.company.id, {
      companyId: fixture.company.id,
      configJson: { credentials: { token: secretRef } },
    }, {
      secretRefs: [{
        secretId: secret.id,
        configPath: "credentials.token",
        versionSelector: "latest",
      }],
    });

    await expect(registry.upsertConfig(fixture.plugin.id, fixture.company.id, {
      companyId: fixture.company.id,
      configJson: { credentials: { token: { ...secretRef, secretId: foreignSecret.id } } },
    }, {
      secretRefs: [{
        secretId: foreignSecret.id,
        configPath: "credentials.token",
        versionSelector: "latest",
      }],
    })).rejects.toThrow(/same company/i);

    const [storedConfig, storedBindings] = await Promise.all([
      db
        .select({ configJson: pluginConfig.configJson })
        .from(pluginConfig)
        .where(and(
          eq(pluginConfig.pluginId, fixture.plugin.id),
          eq(pluginConfig.companyId, fixture.company.id),
        ))
        .then((rows) => rows[0]),
      db
        .select({ secretId: companySecretBindings.secretId })
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, fixture.company.id),
          eq(companySecretBindings.targetId, fixture.plugin.id),
        )),
    ]);
    expect(storedConfig?.configJson).toEqual({ credentials: { token: secretRef } });
    expect(storedBindings).toEqual([{ secretId: secret.id }]);
  });

  it("clears only literal matching bindings while preserving non-secret config", async () => {
    const fixture = await createFixture();
    const [plainSecret, percentSecret, underscoreSecret] = await Promise.all([
      createSecret(fixture.company.id),
      createSecret(fixture.company.id),
      createSecret(fixture.company.id),
    ]);
    const plainRef = { type: "secret_ref" as const, secretId: plainSecret.id };
    const percentRef = { type: "secret_ref" as const, secretId: percentSecret.id };
    const underscoreRef = { type: "secret_ref" as const, secretId: underscoreSecret.id };
    await seedConfig(fixture.plugin.id, fixture.company.id, {
      credentials: { token: plainRef, endpoint: "https://plain.example" },
      "credentials%": { token: percentRef, endpoint: "https://percent.example" },
      credentials_: { token: underscoreRef },
    });
    await Promise.all([
      seedBinding(
        fixture.plugin.id,
        fixture.company.id,
        plainSecret.id,
        "credentials.token",
      ),
      seedBinding(
        fixture.plugin.id,
        fixture.company.id,
        percentSecret.id,
        "credentials%.token",
      ),
      seedBinding(
        fixture.plugin.id,
        fixture.company.id,
        underscoreSecret.id,
        "credentials_.token",
      ),
    ]);

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials%"],
      value: null,
    })).resolves.toEqual({
      credentials: { token: plainRef, endpoint: "https://plain.example" },
      "credentials%": { endpoint: "https://percent.example" },
      credentials_: { token: underscoreRef },
    });

    const remainingPaths = await db
      .select({ configPath: companySecretBindings.configPath })
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, fixture.company.id),
        eq(companySecretBindings.targetId, fixture.plugin.id),
      ))
      .orderBy(asc(companySecretBindings.configPath));
    expect(remainingPaths).toEqual([
      { configPath: "credentials.token" },
      { configPath: "credentials_.token" },
    ]);
  });

  it("clears matching bindings when config uses uppercase UUID casing", async () => {
    const fixture = await createFixture();
    const secret = await createSecret(fixture.company.id);
    await seedConfig(fixture.plugin.id, fixture.company.id, {
      credentials: {
        token: { type: "secret_ref", secretId: secret.id.toUpperCase() },
        endpoint: "https://operator.example",
      },
    });
    await seedBinding(
      fixture.plugin.id,
      fixture.company.id,
      secret.id,
      "credentials.token",
    );

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials"],
      value: null,
    })).resolves.toEqual({
      credentials: { endpoint: "https://operator.example" },
    });

    const remainingBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, fixture.company.id),
        eq(companySecretBindings.targetId, fixture.plugin.id),
      ));
    expect(remainingBindings).toEqual([]);
  });

  it("removes a stale subtree binding without deleting ordinary operator config", async () => {
    const fixture = await createFixture();
    const staleSecret = await createSecret(fixture.company.id);
    const ordinaryConfig = {
      credentials: {
        token: "operator-managed-token",
        endpoint: "https://operator.example",
      },
    };
    await seedConfig(fixture.plugin.id, fixture.company.id, ordinaryConfig);
    await seedBinding(
      fixture.plugin.id,
      fixture.company.id,
      staleSecret.id,
      "credentials.token",
    );

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials"],
      value: null,
    })).resolves.toEqual(ordinaryConfig);

    const remainingBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, fixture.company.id),
        eq(companySecretBindings.targetId, fixture.plugin.id),
      ));
    expect(remainingBindings).toEqual([]);
  });

  it("preserves ordinary values behind stale nested bindings while removing matching refs", async () => {
    const fixture = await createFixture();
    const [staleSecret, liveSecret] = await Promise.all([
      createSecret(fixture.company.id),
      createSecret(fixture.company.id),
    ]);
    const liveRef = { type: "secret_ref" as const, secretId: liveSecret.id };
    await seedConfig(fixture.plugin.id, fixture.company.id, {
      credentials: {
        operatorToken: "keep-operator-value",
        governedToken: liveRef,
      },
    });
    await Promise.all([
      seedBinding(
        fixture.plugin.id,
        fixture.company.id,
        staleSecret.id,
        "credentials.operatorToken",
      ),
      seedBinding(
        fixture.plugin.id,
        fixture.company.id,
        liveSecret.id,
        "credentials.governedToken",
      ),
    ]);

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials"],
      value: {
        operatorToken: null,
        governedToken: null,
      },
    })).resolves.toEqual({
      credentials: { operatorToken: "keep-operator-value" },
    });

    const remainingBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, fixture.company.id),
        eq(companySecretBindings.targetId, fixture.plugin.id),
      ));
    expect(remainingBindings).toEqual([]);
  });

  it("serializes concurrent patches so both secret refs survive", async () => {
    const fixture = await createFixture();
    const [primarySecret, secondarySecret] = await Promise.all([
      createSecret(fixture.company.id),
      createSecret(fixture.company.id),
    ]);
    const primaryRef = { type: "secret_ref" as const, secretId: primarySecret.id };
    const secondaryRef = { type: "secret_ref" as const, secretId: secondarySecret.id };

    await Promise.all([
      fixture.patch({
        companyId: fixture.company.id,
        path: ["credentials", "primary"],
        value: primaryRef,
      }),
      fixture.patch({
        companyId: fixture.company.id,
        path: ["credentials", "secondary"],
        value: secondaryRef,
      }),
    ]);

    const stored = await db
      .select({ configJson: pluginConfig.configJson })
      .from(pluginConfig)
      .where(and(
        eq(pluginConfig.pluginId, fixture.plugin.id),
        eq(pluginConfig.companyId, fixture.company.id),
      ))
      .then((rows) => rows[0]);
    expect(stored?.configJson).toEqual({
      credentials: {
        primary: primaryRef,
        secondary: secondaryRef,
      },
    });

    const bindings = await db
      .select({ configPath: companySecretBindings.configPath })
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, fixture.company.id),
        eq(companySecretBindings.targetId, fixture.plugin.id),
      ))
      .orderBy(asc(companySecretBindings.configPath));
    expect(bindings).toEqual([
      { configPath: "credentials.primary" },
      { configPath: "credentials.secondary" },
    ]);
  });

  it("keeps full config saves and governed patches consistent under concurrency", async () => {
    const fixture = await createFixture();
    const secret = await createSecret(fixture.company.id);
    const secretRef = { type: "secret_ref" as const, secretId: secret.id };
    const registry = pluginRegistryService(db);

    for (let iteration = 0; iteration < 8; iteration += 1) {
      await registry.upsertConfig(fixture.plugin.id, fixture.company.id, {
        companyId: fixture.company.id,
        configJson: { baseline: iteration },
      });
      await Promise.all([
        fixture.patch({
          companyId: fixture.company.id,
          path: ["credentials", "token"],
          value: secretRef,
        }),
        registry.upsertConfig(fixture.plugin.id, fixture.company.id, {
          companyId: fixture.company.id,
          configJson: { operator: iteration },
        }),
      ]);

      const [stored, bindings] = await Promise.all([
        db
          .select({ configJson: pluginConfig.configJson })
          .from(pluginConfig)
          .where(and(
            eq(pluginConfig.pluginId, fixture.plugin.id),
            eq(pluginConfig.companyId, fixture.company.id),
          ))
          .then((rows) => rows[0]),
        db
          .select({ configPath: companySecretBindings.configPath })
          .from(companySecretBindings)
          .where(and(
            eq(companySecretBindings.companyId, fixture.company.id),
            eq(companySecretBindings.targetId, fixture.plugin.id),
          )),
      ]);
      const token = (
        stored?.configJson.credentials as Record<string, unknown> | undefined
      )?.token;
      if (token) {
        expect(token).toEqual(secretRef);
        expect(bindings).toEqual([{ configPath: "credentials.token" }]);
      } else {
        expect(stored?.configJson).toEqual({ operator: iteration });
        expect(bindings).toEqual([]);
      }
    }
  });

  it("rolls back config, bindings, and audit for foreign, inactive, or missing secret versions", async () => {
    const fixture = await createFixture();
    const foreignFixture = await createFixture();
    const foreignSecret = await createSecret(foreignFixture.company.id);
    const inactiveSecret = await createSecret(fixture.company.id, { status: "disabled" });
    const failedVersionSecret = await createSecret(fixture.company.id, {
      versionStatus: "failed",
    });
    const activeSecret = await createSecret(fixture.company.id);
    const invalidRefs = [
      { type: "secret_ref" as const, secretId: foreignSecret.id },
      { type: "secret_ref" as const, secretId: inactiveSecret.id },
      { type: "secret_ref" as const, secretId: failedVersionSecret.id },
      { type: "secret_ref" as const, secretId: activeSecret.id, version: 2 },
    ];

    for (const secretRef of invalidRefs) {
      await expect(fixture.patch({
        companyId: fixture.company.id,
        path: ["credentials", "token"],
        value: secretRef,
      })).rejects.toThrow(/active secret/i);
    }

    const [configs, bindings, audit] = await Promise.all([
      db
        .select()
        .from(pluginConfig)
        .where(and(
          eq(pluginConfig.pluginId, fixture.plugin.id),
          eq(pluginConfig.companyId, fixture.company.id),
        )),
      db
        .select()
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, fixture.company.id),
          eq(companySecretBindings.targetId, fixture.plugin.id),
        )),
      db
        .select()
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, fixture.company.id),
          eq(activityLog.entityId, fixture.plugin.id),
        )),
    ]);
    expect(configs).toEqual([]);
    expect(bindings).toEqual([]);
    expect(audit).toEqual([]);
  });

  it("rejects secret versions outside the governed database range", async () => {
    const fixture = await createFixture();
    const secret = await createSecret(fixture.company.id);

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials", "token"],
      value: {
        type: "secret_ref",
        secretId: secret.id,
        version: 2_147_483_648,
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Plugin secret references must use a valid secret version",
    });

    const [configs, bindings] = await Promise.all([
      db
        .select()
        .from(pluginConfig)
        .where(and(
          eq(pluginConfig.pluginId, fixture.plugin.id),
          eq(pluginConfig.companyId, fixture.company.id),
        )),
      db
        .select()
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, fixture.company.id),
          eq(companySecretBindings.targetId, fixture.plugin.id),
        )),
    ]);
    expect(configs).toEqual([]);
    expect(bindings).toEqual([]);
  });

  it("rejects failed versions during direct secret resolution", async () => {
    const fixture = await createFixture();
    const failedVersionSecret = await createSecret(fixture.company.id, {
      versionStatus: "failed",
    });

    await expect(
      secretService(db).resolveSecretValue(
        fixture.company.id,
        failedVersionSecret.id,
        1,
      ),
    ).rejects.toThrow(/version is not active/i);
  });

  it("removes plugin secret bindings during hard uninstall", async () => {
    const fixture = await createFixture();
    const secret = await createSecret(fixture.company.id);
    await fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials", "token"],
      value: { type: "secret_ref", secretId: secret.id },
    });

    await pluginRegistryService(db).uninstall(fixture.plugin.id, true);

    const [remainingBindings, remainingConfigs, remainingPlugins] = await Promise.all([
      db
        .select()
        .from(companySecretBindings)
        .where(eq(companySecretBindings.targetId, fixture.plugin.id)),
      db
        .select()
        .from(pluginConfig)
        .where(eq(pluginConfig.pluginId, fixture.plugin.id)),
      db
        .select()
        .from(plugins)
        .where(eq(plugins.id, fixture.plugin.id)),
    ]);
    expect(remainingBindings).toEqual([]);
    expect(remainingConfigs).toEqual([]);
    expect(remainingPlugins).toEqual([]);
  });

  it("does not orphan bindings when a hard uninstall races a governed patch", async () => {
    const fixture = await createFixture();
    const [existingSecret, concurrentSecret] = await Promise.all([
      createSecret(fixture.company.id),
      createSecret(fixture.company.id),
    ]);
    await fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials", "existing"],
      value: { type: "secret_ref", secretId: existingSecret.id },
    });
    const registry = pluginRegistryService(db);

    const [patchResult, uninstallResult] = await Promise.allSettled([
      fixture.patch({
        companyId: fixture.company.id,
        path: ["credentials", "concurrent"],
        value: { type: "secret_ref", secretId: concurrentSecret.id },
      }),
      registry.uninstall(fixture.plugin.id, true),
    ]);

    expect(uninstallResult.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(patchResult.status);
    const [remainingBindings, remainingConfigs, remainingPlugins] = await Promise.all([
      db
        .select()
        .from(companySecretBindings)
        .where(eq(companySecretBindings.targetId, fixture.plugin.id)),
      db
        .select()
        .from(pluginConfig)
        .where(eq(pluginConfig.pluginId, fixture.plugin.id)),
      db
        .select()
        .from(plugins)
        .where(eq(plugins.id, fixture.plugin.id)),
    ]);
    expect(remainingBindings).toEqual([]);
    expect(remainingConfigs).toEqual([]);
    expect(remainingPlugins).toEqual([]);
  });

  it("rejects arbitrary config writes and unbound removals", async () => {
    const fixture = await createFixture();

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials"],
      value: { endpoint: "https://attacker.example" },
    })).rejects.toThrow(/only secret_ref objects/i);
    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials"],
      value: { token: null },
    })).rejects.toThrow(/currently bound secret refs/i);
    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["__proto__"],
      value: null,
    })).rejects.toThrow(/safe, non-empty path segments/i);

    const configs = await db
      .select()
      .from(pluginConfig)
      .where(and(
        eq(pluginConfig.pluginId, fixture.plugin.id),
        eq(pluginConfig.companyId, fixture.company.id),
      ));
    expect(configs).toEqual([]);
  });

  it("rejects oversized array indices and traversal through terminal config values", async () => {
    const fixture = await createFixture();
    const [existingSecret, replacementSecret] = await Promise.all([
      createSecret(fixture.company.id),
      createSecret(fixture.company.id),
    ]);
    const existingRef = { type: "secret_ref" as const, secretId: existingSecret.id };
    await seedConfig(fixture.plugin.id, fixture.company.id, {
      credentials: { token: existingRef },
      scalar: "keep",
      items: [],
    });
    await seedBinding(
      fixture.plugin.id,
      fixture.company.id,
      existingSecret.id,
      "credentials.token",
    );

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["items", "100000000"],
      value: { type: "secret_ref", secretId: replacementSecret.id },
    })).rejects.toThrow(/safe, non-empty path segments/i);
    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["items", "1"],
      value: { type: "secret_ref", secretId: replacementSecret.id },
    })).rejects.toThrow(/cannot create sparse arrays/i);
    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["scalar", "nested"],
      value: { type: "secret_ref", secretId: replacementSecret.id },
    })).rejects.toThrow(/incompatible config value/i);
    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials", "token", "nested"],
      value: { type: "secret_ref", secretId: replacementSecret.id },
    })).rejects.toThrow(/incompatible config value/i);

    const [stored, bindings] = await Promise.all([
      db
        .select({ configJson: pluginConfig.configJson })
        .from(pluginConfig)
        .where(and(
          eq(pluginConfig.pluginId, fixture.plugin.id),
          eq(pluginConfig.companyId, fixture.company.id),
        ))
        .then((rows) => rows[0]),
      db
        .select({ secretId: companySecretBindings.secretId })
        .from(companySecretBindings)
        .where(and(
          eq(companySecretBindings.companyId, fixture.company.id),
          eq(companySecretBindings.targetId, fixture.plugin.id),
        )),
    ]);
    expect(stored?.configJson).toEqual({
      credentials: { token: existingRef },
      scalar: "keep",
      items: [],
    });
    expect(bindings).toEqual([{ secretId: existingSecret.id }]);
  });

  it("rejects generated binding paths that exceed the resolver limit", async () => {
    const fixture = await createFixture();
    const secret = await createSecret(fixture.company.id);
    const longPath = Array.from(
      { length: 11 },
      (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(248)}`,
    );

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: longPath,
      value: { type: "secret_ref", secretId: secret.id },
    })).rejects.toThrow(/config path is too long/i);

    const configs = await db
      .select()
      .from(pluginConfig)
      .where(and(
        eq(pluginConfig.pluginId, fixture.plugin.id),
        eq(pluginConfig.companyId, fixture.company.id),
      ));
    expect(configs).toEqual([]);
  });

  it("accepts refs at schema-declared secret fields and rejects undeclared paths", async () => {
    const schema = {
      type: "object",
      required: ["credentials"],
      $defs: {
        secretRef: {
          $id: "#secret",
          type: "string",
          format: "secret-ref",
        },
      },
      properties: {
        credentials: {
          type: "object",
          required: ["token"],
          properties: {
            token: {
              $ref: "#secret",
            },
          },
        },
        other: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
      patternProperties: {
        "^dynamic_": {
          $ref: "#%2F$defs%2FsecretRef",
        },
      },
    } satisfies NonNullable<PaperclipPluginManifestV1["instanceConfigSchema"]>;
    const fixture = await createFixture(schema);
    const declaredSecret = await createSecret(fixture.company.id);
    const patternSecret = await createSecret(fixture.company.id);
    const undeclaredSecret = await createSecret(fixture.company.id);
    const declaredRef = { type: "secret_ref" as const, secretId: declaredSecret.id };
    const patternRef = { type: "secret_ref" as const, secretId: patternSecret.id };

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials", "token"],
      value: declaredRef,
      schema,
    })).resolves.toEqual({
      credentials: { token: declaredRef },
    });

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["dynamic_api"],
      value: patternRef,
      schema,
    })).resolves.toEqual({
      credentials: { token: declaredRef },
      dynamic_api: patternRef,
    });

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["other", "token"],
      value: { type: "secret_ref", secretId: undeclaredSecret.id },
      schema,
    })).rejects.toThrow(/must be declared with format "secret-ref"/i);

    const stored = await db
      .select({ configJson: pluginConfig.configJson })
      .from(pluginConfig)
      .where(and(
        eq(pluginConfig.pluginId, fixture.plugin.id),
        eq(pluginConfig.companyId, fixture.company.id),
      ))
      .then((rows) => rows[0]);
    expect(stored?.configJson).toEqual({
      credentials: { token: declaredRef },
      dynamic_api: patternRef,
    });
  });

  it("reports unsupported config-schema dialect keywords as validation failures", async () => {
    const schema = {
      type: "object",
      dependentSchemas: {
        credentials: {
          properties: {
            token: { type: "string", format: "secret-ref" },
          },
        },
      },
    } satisfies NonNullable<PaperclipPluginManifestV1["instanceConfigSchema"]>;
    const fixture = await createFixture(schema);
    const secret = await createSecret(fixture.company.id);

    await expect(fixture.patch({
      companyId: fixture.company.id,
      path: ["credentials", "token"],
      value: { type: "secret_ref", secretId: secret.id },
      schema,
    })).rejects.toThrow(/config validation failed/i);
  });
});
