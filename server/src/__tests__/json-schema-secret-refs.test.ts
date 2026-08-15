import { describe, expect, it } from "vitest";
import {
  collectSecretRefPaths,
  compactConfigArrays,
  inspectSecretRefPaths,
  readConfigValueAtPath,
  scopeConfigResourceArrays,
  writeConfigValueAtPath,
} from "../services/json-schema-secret-refs.ts";

describe("collectSecretRefPaths", () => {
  it("collects nested secret-ref paths from object properties", () => {
    expect(Array.from(collectSecretRefPaths({
      type: "object",
      properties: {
        credentials: {
          type: "object",
          properties: {
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
      },
    }))).toEqual(["credentials.apiKey"]);
  });

  it("collects secret-ref paths from JSON Schema composition keywords", () => {
    expect(Array.from(collectSecretRefPaths({
      type: "object",
      allOf: [
        {
          properties: {
            apiKey: { type: "string", format: "secret-ref" },
          },
        },
        {
          properties: {
            nested: {
              oneOf: [
                {
                  properties: {
                    token: { type: "string", format: "secret-ref" },
                  },
                },
              ],
            },
          },
        },
      ],
    })).sort()).toEqual(["apiKey", "nested.token"]);
  });

  it("collects and updates secret refs nested in configured array items", () => {
    const config = {
      agentCredentials: [
        { agentId: "agent-1", apiToken: "token-1" },
        { agentId: "agent-2", apiToken: "token-2" },
      ],
    };
    const schema = {
      type: "object",
      properties: {
        agentCredentials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              apiToken: { type: "string", format: "secret-ref" },
            },
          },
        },
      },
    };

    expect(Array.from(collectSecretRefPaths(schema, config))).toEqual([
      "agentCredentials.0.apiToken",
      "agentCredentials.1.apiToken",
    ]);
    expect(readConfigValueAtPath(config, "agentCredentials.1.apiToken")).toBe("token-2");
    expect(
      readConfigValueAtPath(
        writeConfigValueAtPath(config, "agentCredentials.1.apiToken", "secret-ref-2"),
        "agentCredentials.1.apiToken",
      ),
    ).toBe("secret-ref-2");
  });

  it("scopes resource-keyed config arrays before nested secret resolution", () => {
    const config = {
      agentCredentials: [
        { agentId: "agent-1", apiToken: "token-1" },
        { agentId: "agent-2", apiToken: "token-2" },
      ],
    };
    const schema = {
      type: "object",
      properties: {
        agentCredentials: {
          type: "array",
          "x-paperclip-runtime-scope": {
            resource: "agent",
            field: "agentId",
            fallback: "first",
          },
          items: {
            type: "object",
            properties: {
              agentId: {
                type: "string",
                "x-paperclip-resource": "agent",
              },
              apiToken: { type: "string", format: "secret-ref" },
            },
          },
        },
      },
    };

    expect(compactConfigArrays(scopeConfigResourceArrays(schema, config, { agent: "agent-2" }))).toEqual({
      agentCredentials: [{ agentId: "agent-2", apiToken: "token-2" }],
    });
    expect(compactConfigArrays(scopeConfigResourceArrays(schema, config, { agent: "agent-missing" }))).toEqual({
      agentCredentials: [],
    });
    expect(compactConfigArrays(scopeConfigResourceArrays(schema, config))).toEqual({
      agentCredentials: [{ agentId: "agent-1", apiToken: "token-1" }],
    });

    const uiOnlySchema = structuredClone(schema);
    delete uiOnlySchema.properties.agentCredentials["x-paperclip-runtime-scope"];
    expect(compactConfigArrays(scopeConfigResourceArrays(uiOnlySchema, config, { agent: "agent-2" }))).toEqual(config);

    const invalidScopeSchema = structuredClone(schema);
    invalidScopeSchema.properties.agentCredentials["x-paperclip-runtime-scope"] = {
      resource: "agent",
      field: "__proto__",
      fallback: "first",
    };
    expect(compactConfigArrays(scopeConfigResourceArrays(invalidScopeSchema, config, { agent: "agent-2" }))).toEqual({
      agentCredentials: [],
    });
  });

  it("scopes resource-keyed arrays nested under patternProperties and additionalProperties", () => {
    const scopedArraySchema = {
      type: "array",
      "x-paperclip-runtime-scope": {
        resource: "agent",
        field: "agentId",
        fallback: "first",
      },
      items: {
        type: "object",
        properties: {
          agentId: { type: "string", "x-paperclip-resource": "agent" },
          apiToken: { type: "string", format: "secret-ref" },
        },
      },
    };
    const makeConfig = () => ({
      byRegion: {
        useast: [
          { agentId: "agent-1", apiToken: "token-1" },
          { agentId: "agent-2", apiToken: "token-2" },
        ],
      },
      dynamic: {
        extra: [
          { agentId: "agent-1", apiToken: "token-3" },
          { agentId: "agent-2", apiToken: "token-4" },
        ],
      },
    });
    const schema = {
      type: "object",
      properties: {
        byRegion: {
          type: "object",
          patternProperties: {
            "^us": scopedArraySchema,
          },
        },
        dynamic: {
          type: "object",
          additionalProperties: scopedArraySchema,
        },
      },
    };

    expect(compactConfigArrays(scopeConfigResourceArrays(schema, makeConfig(), { agent: "agent-2" }))).toEqual({
      byRegion: { useast: [{ agentId: "agent-2", apiToken: "token-2" }] },
      dynamic: { extra: [{ agentId: "agent-2", apiToken: "token-4" }] },
    });
    expect(compactConfigArrays(scopeConfigResourceArrays(schema, makeConfig(), { agent: "agent-1" }))).toEqual({
      byRegion: { useast: [{ agentId: "agent-1", apiToken: "token-1" }] },
      dynamic: { extra: [{ agentId: "agent-1", apiToken: "token-3" }] },
    });
  });

  it("collects composed primitive refs in nested arrays", () => {
    const config = {
      token: "top-level",
      tokenGroups: [["nested-1", "nested-2"]],
    };
    const schema = {
      type: "object",
      properties: {
        token: {
          oneOf: [{ type: "string", format: "secret-ref" }],
        },
        tokenGroups: {
          type: "array",
          items: {
            type: "array",
            items: {
              anyOf: [{ type: "string", format: "secret-ref" }],
            },
          },
        },
      },
    };

    expect(Array.from(collectSecretRefPaths(schema, config))).toEqual([
      "token",
      "tokenGroups.0.0",
      "tokenGroups.0.1",
    ]);
  });

  it("resolves local refs into $defs", () => {
    const schema = {
      type: "object",
      $defs: {
        credentials: {
          type: "object",
          properties: {
            token: { type: "string", format: "secret-ref" },
          },
        },
      },
      properties: {
        integration: { $ref: "#/$defs/credentials" },
      },
    };

    expect(Array.from(collectSecretRefPaths(schema, {
      integration: { token: "plaintext" },
    }))).toEqual(["integration.token"]);
  });

  it("collects secret refs from dynamic additional properties", () => {
    const schema = {
      type: "object",
      properties: {
        tokens: {
          type: "object",
          additionalProperties: { type: "string", format: "secret-ref" },
        },
      },
    };

    expect(Array.from(collectSecretRefPaths(schema, {
      tokens: { github: "token-1", slack: "token-2" },
    }))).toEqual(["tokens.github", "tokens.slack"]);
  });

  it("round-trips dynamic keys that contain a dot", () => {
    const schema = {
      type: "object",
      properties: {
        tokens: {
          type: "object",
          additionalProperties: { type: "string", format: "secret-ref" },
        },
      },
    };
    const config = { tokens: { "github.com": "plaintext-token" } };

    const [path] = Array.from(collectSecretRefPaths(schema, config));
    expect(path).toBe("tokens.github~1com");
    expect(readConfigValueAtPath(config, path!)).toBe("plaintext-token");

    const cleared = writeConfigValueAtPath(config, path!, undefined);
    expect(cleared).toEqual({ tokens: {} });
    expect(config).toEqual({ tokens: { "github.com": "plaintext-token" } });

    const rewritten = writeConfigValueAtPath(config, path!, "secret-uuid");
    expect(rewritten).toEqual({ tokens: { "github.com": "secret-uuid" } });
  });

  it("collects tuple and additional item secret refs", () => {
    const schema = {
      type: "object",
      properties: {
        credentials: {
          type: "array",
          items: [
            { type: "string" },
            { type: "string", format: "secret-ref" },
          ],
          additionalItems: { type: "string", format: "secret-ref" },
        },
      },
    };

    expect(Array.from(collectSecretRefPaths(schema, {
      credentials: ["label", "token-1", "token-2"],
    }))).toEqual(["credentials.1", "credentials.2"]);
  });

  it("deletes an array item without shifting sibling secret paths", () => {
    const updated = writeConfigValueAtPath({ tokens: ["remove-me", "keep-me"] }, "tokens.0", undefined);

    expect(readConfigValueAtPath(updated, "tokens.0")).toBeUndefined();
    expect(readConfigValueAtPath(updated, "tokens.1")).toBe("keep-me");
    expect(JSON.stringify(updated)).not.toContain("remove-me");

    const compacted = compactConfigArrays(updated);
    expect(compacted).toEqual({ tokens: ["keep-me"] });
    expect(JSON.stringify(compacted)).not.toContain("null");
  });
});

describe("inspectSecretRefPaths completeness", () => {
  it("marks incomplete when an unsupported keyword hides a secret-ref", () => {
    const result = inspectSecretRefPaths({
      type: "object",
      if: { properties: { mode: { const: "token" } } },
      then: { properties: { apiKey: { type: "string", format: "secret-ref" } } },
    }, { mode: "token", apiKey: "plaintext-secret" });
    expect(result.complete).toBe(false);
    expect(Array.from(result.paths)).not.toContain("apiKey");
  });

  it("stays complete when an unsupported keyword governs no secret-ref", () => {
    const result = inspectSecretRefPaths({
      type: "object",
      not: { properties: { forbidden: { const: true } } },
      properties: { apiKey: { type: "string", format: "secret-ref" } },
    }, { apiKey: "22222222-2222-4222-8222-222222222222" });
    expect(result.complete).toBe(true);
    expect(Array.from(result.paths)).toEqual(["apiKey"]);
  });

  it("marks incomplete for an opaque $dynamicRef governing credentials", () => {
    const result = inspectSecretRefPaths({
      type: "object",
      then: { $dynamicRef: "#meta" },
    }, { apiKey: "plaintext" });
    expect(result.complete).toBe(false);
  });

  it("marks incomplete when draft-07 dependencies schema-form hides a secret-ref", () => {
    const result = inspectSecretRefPaths({
      type: "object",
      dependencies: {
        trigger: { properties: { apiKey: { type: "string", format: "secret-ref" } } },
      },
    }, { trigger: "on", apiKey: "plaintext-secret" });
    expect(result.complete).toBe(false);
    expect(Array.from(result.paths)).not.toContain("apiKey");
  });

  it("stays complete for a draft-07 dependencies property-dependency array form", () => {
    const result = inspectSecretRefPaths({
      type: "object",
      dependencies: { trigger: ["companion"] },
      properties: { apiKey: { type: "string", format: "secret-ref" } },
    }, { apiKey: "33333333-3333-4333-8333-333333333333" });
    expect(result.complete).toBe(true);
    expect(Array.from(result.paths)).toEqual(["apiKey"]);
  });
});
