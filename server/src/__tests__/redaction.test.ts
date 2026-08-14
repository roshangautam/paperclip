import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, redactPersistedCredentialValues, redactSensitiveText, sanitizeRecord } from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command: "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: ["--safe", "ok", "--token", "ghp_arg_secret", "--api-key=sk-inline-example"],
      env: {
        PAPERCLIP_RESOLVED_COMMAND: "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND:
        `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual(["--api-key", REDACTED_EVENT_VALUE, "safe-next"]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });
});

describe("redactPersistedCredentialValues", () => {
  it("redacts credential-shaped values while preserving reuse-critical structure", () => {
    const result = redactPersistedCredentialValues({
      accessToken: "provider-plaintext",
      agentCredentials: [{ agentId: "agent-2" }],
      secretName: "provider-runtime-secret-name",
      sandboxId: "sandbox-1",
      remoteCwd: "/workspace",
    });

    expect(result).toEqual({
      accessToken: REDACTED_EVENT_VALUE,
      agentCredentials: [{ agentId: "agent-2" }],
      secretName: "provider-runtime-secret-name",
      sandboxId: "sandbox-1",
      remoteCwd: "/workspace",
    });
  });

  it("keeps values under preserved secret-ref container paths intact", () => {
    const result = redactPersistedCredentialValues(
      { agentCredentials: [{ agentId: "agent-2", apiToken: undefined }] },
      { preserveContainerPaths: new Set(["agentCredentials", "agentCredentials.0"]) },
    );

    expect(result).toEqual({ agentCredentials: [{ agentId: "agent-2", apiToken: undefined }] });
  });

  it("does not treat words merely ending in identifier letters as identifiers", () => {
    const result = redactPersistedCredentialValues({
      credentials: {
        valid: "plaintext-secret-1",
        hybrid: "plaintext-secret-2",
        solid: "plaintext-secret-3",
        agentId: "agent-9",
      },
    }) as { credentials: Record<string, unknown> };

    expect(result.credentials.valid).toBe(REDACTED_EVENT_VALUE);
    expect(result.credentials.hybrid).toBe(REDACTED_EVENT_VALUE);
    expect(result.credentials.solid).toBe(REDACTED_EVENT_VALUE);
    expect(result.credentials.agentId).toBe("agent-9");
  });

  it("redacts a JWT stored under an identifier-shaped key while preserving ordinary ids", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc-DEF_123";
    const result = redactPersistedCredentialValues({
      tokenId: jwt,
      sessionId: jwt,
      sandboxId: "sandbox-1",
      remoteCwd: "/workspace",
    }) as Record<string, unknown>;

    expect(result.tokenId).toBe(REDACTED_EVENT_VALUE);
    expect(result.sessionId).toBe(REDACTED_EVENT_VALUE);
    expect(result.sandboxId).toBe("sandbox-1");
    expect(result.remoteCwd).toBe("/workspace");
  });
});
