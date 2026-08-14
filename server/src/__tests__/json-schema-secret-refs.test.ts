import { describe, expect, it } from "vitest";
import {
  collectSecretRefPaths,
  compactConfigArrays,
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
