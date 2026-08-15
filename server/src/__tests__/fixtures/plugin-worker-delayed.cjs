const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["environmentExecute", "environmentRealizeWorkspace"],
      },
    });
    return;
  }

  if (method === "environmentExecute") {
    const delayMs = Number(message.params?.delayMs ?? 0);
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: typeof message.params?.stdout === "string" ? message.params.stdout : "ok\n",
          stderr: typeof message.params?.stderr === "string" ? message.params.stderr : "",
        },
      });
    }, delayMs);
    return;
  }

  if (method === "environmentRealizeWorkspace") {
    const secret = message.params?.env?.GITHUB_APP_PRIVATE_KEY
      ?? message.params?.env?.GITHUB_TOKEN
      ?? message.params?.env?.GH_TOKEN
      ?? "";
    process.stdout.write(`not-json:${JSON.stringify(secret)}\n`);
    process.stderr.write(`${secret}\n`);
    send({
      jsonrpc: "2.0",
      method: "log",
      params: {
        level: "warn",
        message: `provider received ${secret}`,
        meta: { serialized: JSON.stringify({ secret }) },
      },
      paperclipInvocationId: message.paperclipInvocation?.id,
    });
    if (message.params?.config?.crash) {
      process.exit(1);
    }
    if (message.params?.config?.protocolFieldLeak) {
      send({
        jsonrpc: "2.0",
        id: secret,
        result: {},
      });
      send({
        jsonrpc: "2.0",
        method: secret,
        params: {},
      });
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { cwd: "/workspace/project", metadata: {} },
      });
      return;
    }
    if (message.params?.config?.errorEcho) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `provider rejected token ${secret}`,
          data: { forwarded: secret },
        },
      });
      return;
    }
    if (message.params?.config?.errorEchoNestedToken) {
      let nestedToken = "";
      try {
        const envelope = JSON.parse(message.params?.env?.PAPERCLIP_CLAUDE_MCP_CONFIG ?? "{}");
        nestedToken = envelope?.mcpServers?.gw?.headers?.Authorization ?? "";
      } catch {
        nestedToken = "";
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `provider rejected ${nestedToken}`,
          data: { extracted: nestedToken },
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: message.params?.config?.resultEcho
        ? {
            cwd: `/workspace/${message.params?.env?.GITHUB_APP_ID ?? "app"}/project`,
            metadata: { echoed: `provider stored ${secret}`, appId: message.params?.env?.GITHUB_APP_ID ?? null },
          }
        : { cwd: "/workspace/project", metadata: {} },
    });
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Unhandled method: ${method}`,
    },
  });
});
