import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  normalizeEnvironmentConfig,
  parseEnvironmentDriverConfig,
  presentEnvironmentConfigForRead,
  type SandboxProviderSchemaCache,
} from "../services/environment-config.ts";

describe("environment config helpers", () => {
  it("normalizes SSH config into its canonical stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: "2222",
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "latest",
        },
        knownHosts: "",
      },
    });

    expect(config).toEqual({
      host: "ssh.example.test",
      port: 2222,
      username: "ssh-user",
      remoteWorkspacePath: "/srv/paperclip/workspace",
      privateKey: null,
      privateKeySecretRef: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
        version: "latest",
      },
      knownHosts: null,
      strictHostKeyChecking: true,
    });
  });

  it("rejects raw SSH private keys in the stored config shape", () => {
    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          port: "2222",
          username: "ssh-user",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: "PRIVATE KEY",
        },
      }),
    ).toThrow(HttpError);
  });

  it("rejects SSH config without an absolute remote workspace path", () => {
    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "workspace",
        },
      }),
    ).toThrow(HttpError);

    expect(() =>
      normalizeEnvironmentConfig({
        driver: "ssh",
        config: {
          host: "ssh.example.test",
          username: "ssh-user",
          remoteWorkspacePath: "workspace",
        },
      }),
    ).toThrow("absolute");
  });

  it("parses a persisted SSH environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: false,
      },
    });

    expect(parsed).toEqual({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        privateKeySecretRef: null,
        knownHosts: null,
        strictHostKeyChecking: false,
      },
    });
  });

  it("normalizes sandbox config into its canonical stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "  ubuntu:24.04  ",
      },
    });

    expect(config).toEqual({
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: false,
    });
  });

  it("parses a persisted sandbox environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    expect(parsed).toEqual({
      driver: "sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });
  });

  it("normalizes schema-driven sandbox config into the generic plugin-backed stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "sandbox",
      config: {
        provider: "secure-plugin",
        template: "  base  ",
        apiKey: "22222222-2222-2222-2222-222222222222",
        timeoutMs: "450000",
      },
    });

    expect(config).toEqual({
      provider: "secure-plugin",
      template: "  base  ",
      apiKey: "22222222-2222-2222-2222-222222222222",
      timeoutMs: 450000,
      reuseLease: false,
    });
  });

  it("normalizes plugin-backed sandbox provider config without server provider changes", () => {
    const config = normalizeEnvironmentConfig({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        image: "  fake:test  ",
        timeoutMs: "120000",
        reuseLease: true,
        customFlag: "kept",
      },
    });

    expect(config).toEqual({
      provider: "fake-plugin",
      image: "  fake:test  ",
      timeoutMs: 120000,
      reuseLease: true,
      customFlag: "kept",
    });
  });

  it("parses a persisted schema-driven sandbox environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "sandbox",
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "22222222-2222-2222-2222-222222222222",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(parsed).toEqual({
      driver: "sandbox",
      config: {
        provider: "secure-plugin",
        template: "base",
        apiKey: "22222222-2222-2222-2222-222222222222",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });
  });

  it("parses a persisted plugin-backed sandbox environment into a typed driver config", () => {
    const parsed = parseEnvironmentDriverConfig({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });

    expect(parsed).toEqual({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 300000,
        reuseLease: true,
      },
    });
  });

  it("normalizes plugin environment config into its canonical stored shape", () => {
    const config = normalizeEnvironmentConfig({
      driver: "plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    expect(config).toEqual({
      pluginKey: "acme.environments",
      driverKey: "fake-plugin",
      driverConfig: {
        template: "base",
      },
    });
  });

  it("residually redacts undeclared credential-shaped fields when presenting sandbox config for read", async () => {
    const schemaCache: SandboxProviderSchemaCache = new Map([
      [
        "acme.provider",
        {
          type: "object",
          properties: {
            apiKeySecretRef: { type: "string", format: "secret-ref" },
            region: { type: "string" },
          },
        },
      ],
    ]);

    const presented = await presentEnvironmentConfigForRead(
      {} as never,
      {
        driver: "sandbox",
        config: {
          provider: "acme.provider",
          region: "us-east-1",
          apiKeySecretRef: "11111111-1111-1111-1111-111111111111",
          accessToken: "ghs_undeclared_plaintext_secret",
        },
      },
      schemaCache,
    );

    expect(presented.region).toBe("us-east-1");
    expect(presented.apiKeySecretRef).toBe("11111111-1111-1111-1111-111111111111");
    expect(presented.accessToken).not.toBe("ghs_undeclared_plaintext_secret");
    expect(JSON.stringify(presented)).not.toContain("ghs_undeclared_plaintext_secret");
  });
});
