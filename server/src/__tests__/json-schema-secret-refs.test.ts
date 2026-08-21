import { describe, expect, it } from "vitest";
import {
  collectSecretRefPaths,
  parseSecretRefBindingObject,
  readConfigValueAtPath,
  sortConfigPathsForRemoval,
  writeConfigValueAtPath,
} from "../services/json-schema-secret-refs.ts";

describe("parseSecretRefBindingObject", () => {
  const secretId = "11111111-1111-1111-1111-111111111111";

  it("parses a binding object and defaults the version to latest", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId })).toEqual({
      secretId,
      version: "latest",
    });
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: "latest" })).toEqual({
      secretId,
      version: "latest",
    });
  });

  it("parses a pinned numeric version", () => {
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: 3 })).toEqual({
      secretId,
      version: 3,
    });
  });

  it("rejects non-binding values", () => {
    expect(parseSecretRefBindingObject(secretId)).toBeNull();
    expect(parseSecretRefBindingObject("raw-api-key")).toBeNull();
    expect(parseSecretRefBindingObject(null)).toBeNull();
    expect(parseSecretRefBindingObject([{ type: "secret_ref", secretId }])).toBeNull();
    expect(parseSecretRefBindingObject({ type: "user_secret_ref", secretId })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId: "not-a-uuid" })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: 0 })).toBeNull();
    expect(parseSecretRefBindingObject({ type: "secret_ref", secretId, version: "2" })).toBeNull();
  });
});

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

  it("collects concrete secret-ref paths from array items", () => {
    const schema = {
      type: "object",
      properties: {
        agentCredentials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              apiToken: { type: "string", format: "secret-ref" },
            },
          },
        },
      },
    };
    const config = {
      agentCredentials: [
        { agentId: "agent-a", apiToken: "secret-a" },
        { agentId: "agent-b", apiToken: "secret-b" },
      ],
    };

    expect(Array.from(collectSecretRefPaths(schema, config))).toEqual([
      "agentCredentials.0.apiToken",
      "agentCredentials.1.apiToken",
    ]);
  });

  it("collects direct secret-ref array items", () => {
    const schema = {
      type: "object",
      properties: {
        tokens: {
          type: "array",
          items: { type: "string", format: "secret-ref" },
        },
      },
    };

    expect(Array.from(collectSecretRefPaths(schema, {
      tokens: ["secret-a", "secret-b"],
    }))).toEqual(["tokens.0", "tokens.1"]);
  });

  it("rejects secret refs below schema property names that dot paths cannot represent", () => {
    expect(() => collectSecretRefPaths({
      type: "object",
      properties: {
        credentials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              "api.token": { type: "string", format: "secret-ref" },
            },
          },
        },
      },
    }, {
      credentials: [{ "api.token": "raw-secret" }],
    })).toThrow('Secret-ref schema property "api.token" cannot contain a dot.');
  });

  it("rejects a dotted secret property when its lossy path was already discovered", () => {
    expect(() => collectSecretRefPaths({
      type: "object",
      properties: {
        api: {
          type: "object",
          properties: {
            token: { type: "string", format: "secret-ref" },
          },
        },
        "api.token": { type: "string", format: "secret-ref" },
      },
    }, {
      api: { token: "nested-secret" },
      "api.token": "raw-secret",
    })).toThrow('Secret-ref schema property "api.token" cannot contain a dot.');
  });

  it("collects secret refs from tuple items, additional items, and local refs", () => {
    const schema = {
      $defs: {
        credential: {
          type: "object",
          properties: {
            apiToken: { type: "string", format: "secret-ref" },
          },
        },
      },
      type: "object",
      properties: {
        credentials: {
          type: "array",
          items: [
            { $ref: "#/$defs/credential" },
            { type: "string" },
          ],
          additionalItems: { $ref: "#/$defs/credential" },
        },
      },
    };

    expect(Array.from(collectSecretRefPaths(schema, {
      credentials: [
        { apiToken: "first-secret" },
        "non-secret",
        { apiToken: "third-secret" },
      ],
    }))).toEqual(["credentials.0.apiToken", "credentials.2.apiToken"]);
  });

  it("stops recursive local refs after concrete values end", () => {
    const schema = {
      $defs: {
        node: {
          type: "object",
          properties: {
            apiToken: { type: "string", format: "secret-ref" },
            child: { $ref: "#/$defs/node" },
          },
        },
      },
      type: "object",
      properties: {
        root: { $ref: "#/$defs/node" },
      },
    };

    expect(Array.from(collectSecretRefPaths(schema, {
      root: {
        apiToken: "first-secret",
        child: { apiToken: "second-secret" },
      },
    }))).toEqual(["root.apiToken", "root.child.apiToken"]);
  });

  it("reads and writes concrete array-item paths without mutating the source", () => {
    const config = {
      agentCredentials: [
        { agentId: "agent-a", apiToken: "secret-a" },
        { agentId: "agent-b", apiToken: "secret-b" },
      ],
    };

    expect(readConfigValueAtPath(config, "agentCredentials.1.apiToken")).toBe("secret-b");
    expect(readConfigValueAtPath(config, "agentCredentials.one.apiToken")).toBeUndefined();
    expect(writeConfigValueAtPath(config, "agentCredentials.1.apiToken", "resolved-b")).toEqual({
      agentCredentials: [
        { agentId: "agent-a", apiToken: "secret-a" },
        { agentId: "agent-b", apiToken: "resolved-b" },
      ],
    });
    expect(config.agentCredentials[1]?.apiToken).toBe("secret-b");
  });

  it("removes indexed paths without sparse arrays or shifted path loss", () => {
    const config = { tokens: ["first", "second", "third"] };

    let next = config;
    for (const path of sortConfigPathsForRemoval(["tokens.0", "tokens.1"])) {
      next = writeConfigValueAtPath(next, path, undefined);
    }

    expect(next).toEqual({ tokens: ["third"] });
    expect(next.tokens).not.toHaveProperty("1");
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
});
