import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for DRO-1074 / DRO-1089: the webhook route must send a
// plugin-provided string response body verbatim (e.g. Slack's
// url_verification challenge echo), not JSON-quoted via res.json().

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({ load: vi.fn(), upgrade: vi.fn() }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ getById: vi.fn(), assertCheckoutOwner: vi.fn() }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

function makeMockDb() {
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: "delivery-1" }]),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return {
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
  };
}

async function createApp(workerResult: unknown) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const workerManager = {
    isRunning: vi.fn().mockReturnValue(true),
    call: vi.fn().mockResolvedValue(workerResult),
  };

  const pluginId = "11111111-1111-4111-8111-111111111111";
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "acme.webhook-test",
    status: "ready",
    manifestJson: {
      id: "acme.webhook-test",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Webhook Test",
      description: "Test plugin",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["webhooks.receive"],
      entrypoints: { worker: "dist/worker.js" },
      webhooks: [{ endpointKey: "inbound", description: "Inbound webhook" }],
    },
  });

  const db = makeMockDb();
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    pluginRoutes(db as never, {} as never, undefined, { workerManager } as never),
  );
  app.use(errorHandler);

  return { app, pluginId };
}

describe.sequential("plugin webhook response body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a string response body verbatim instead of JSON-quoting it", async () => {
    const { app, pluginId } = await createApp({
      status: 200,
      body: "challenge-abc-123",
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/inbound`)
      .send({ type: "url_verification", challenge: "challenge-abc-123" });

    expect(res.status).toBe(200);
    expect(res.text).toBe("challenge-abc-123");
    // Must NOT be JSON-quoted (i.e. not `"challenge-abc-123"`).
    expect(res.text).not.toBe('"challenge-abc-123"');
  });

  it("still JSON-encodes object response bodies", async () => {
    const { app, pluginId } = await createApp({
      status: 200,
      body: { ok: true },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/inbound`)
      .send({ some: "payload" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("falls back to the default acknowledgement when the handler returns void", async () => {
    const { app, pluginId } = await createApp(undefined);

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/inbound`)
      .send({ some: "payload" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deliveryId: "delivery-1", status: "success" });
  });
});
