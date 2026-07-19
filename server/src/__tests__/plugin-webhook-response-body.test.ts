import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for DRO-1074 / DRO-1089: the webhook route must send a
// plugin-provided string response body verbatim (e.g. Slack's
// url_verification challenge echo), not JSON-quoted via res.json().

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
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

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

let pluginRoutes: typeof import("../routes/plugins.js").pluginRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

beforeAll(async () => {
  [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);
});

function makeMockDb(companyExists: boolean) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const insertChain = {
    values: vi.fn(),
    returning: vi.fn().mockResolvedValue([{ id: "delivery-1" }]),
  };
  insertChain.values.mockImplementation((values: Record<string, unknown>) => {
    insertedValues.push(values);
    return insertChain;
  });
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(companyExists ? [{ id: COMPANY_ID }] : []),
  };
  const db = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
  };
  return { db, insertedValues };
}

async function createApp(
  workerResult: unknown,
  options: { companyExists?: boolean } = {},
) {
  const workerManager = {
    isRunning: vi.fn().mockReturnValue(true),
    call: vi.fn().mockResolvedValue(workerResult),
  };

  mockRegistry.getById.mockResolvedValue({
    id: PLUGIN_ID,
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
  const { db, insertedValues } = makeMockDb(options.companyExists !== false);
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf);
    },
  }));
  app.use(
    "/api",
    pluginRoutes(db as never, {} as never, undefined, { workerManager } as never),
  );
  app.use(errorHandler);

  return { app, db, insertedValues, workerManager };
}

describe.sequential("plugin webhook response body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a string response body verbatim instead of JSON-quoting it", async () => {
    const { app, workerManager } = await createApp({
      status: 200,
      body: "challenge-abc-123",
    });
    const rawPayload = [
      "{",
      '  "type": "url_verification",',
      '  "challenge": "challenge-abc-123"',
      "}",
    ].join("\n");

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/plugins/${PLUGIN_ID}/webhooks/inbound`)
      .set("Content-Type", "application/json")
      .send(rawPayload);

    expect(res.status).toBe(200);
    expect(res.text).toBe("challenge-abc-123");
    // Must NOT be JSON-quoted (i.e. not `"challenge-abc-123"`).
    expect(res.text).not.toBe('"challenge-abc-123"');
    expect(workerManager.call).toHaveBeenCalledWith(
      PLUGIN_ID,
      "handleWebhook",
      expect.objectContaining({
        companyId: COMPANY_ID,
        rawBody: rawPayload,
        parsedBody: {
          type: "url_verification",
          challenge: "challenge-abc-123",
        },
      }),
    );
  });

  it("still JSON-encodes object response bodies", async () => {
    const { app } = await createApp({
      status: 200,
      body: { ok: true },
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/plugins/${PLUGIN_ID}/webhooks/inbound`)
      .send({ some: "payload" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("falls back to the default acknowledgement when the handler returns void", async () => {
    const { app } = await createApp(undefined);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/plugins/${PLUGIN_ID}/webhooks/inbound`)
      .send({ some: "payload" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deliveryId: "delivery-1", status: "success" });
  });

  it("rejects an invalid company ID before looking up tenant state", async () => {
    const { app, db, workerManager } = await createApp(undefined);

    const res = await request(app)
      .post(`/api/companies/not-a-uuid/plugins/${PLUGIN_ID}/webhooks/inbound`)
      .send({ some: "payload" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid company ID" });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("rejects an unknown company", async () => {
    const { app, workerManager } = await createApp(undefined, { companyExists: false });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/plugins/${PLUGIN_ID}/webhooks/inbound`)
      .send({ some: "payload" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Company not found" });
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("accepts a webhook for a fresh or configless plugin", async () => {
    mockRegistry.getConfig.mockResolvedValue(null);
    const { app, db, workerManager } = await createApp(undefined);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/plugins/${PLUGIN_ID}/webhooks/inbound`)
      .send({ some: "payload" });

    expect(res.status).toBe(200);
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledOnce();
    expect(workerManager.call).toHaveBeenCalledWith(
      PLUGIN_ID,
      "handleWebhook",
      expect.objectContaining({ companyId: COMPANY_ID }),
    );
  });

  it("denies the legacy instance-scoped webhook URL", async () => {
    const { app, db, workerManager } = await createApp(undefined);

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/inbound`)
      .send({ some: "payload" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Company-scoped webhook endpoint required" });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("uses only the URL company for persistence and worker dispatch", async () => {
    const { app, insertedValues, workerManager } = await createApp(undefined);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/plugins/${PLUGIN_ID}/webhooks/inbound`)
      .set("x-paperclip-company-id", OTHER_COMPANY_ID)
      .send({ companyId: OTHER_COMPANY_ID, some: "payload" });

    expect(res.status).toBe(200);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toEqual(expect.objectContaining({
      pluginId: PLUGIN_ID,
      companyId: COMPANY_ID,
      webhookKey: "inbound",
      payload: { companyId: OTHER_COMPANY_ID, some: "payload" },
    }));
    expect(workerManager.call).toHaveBeenCalledWith(
      PLUGIN_ID,
      "handleWebhook",
      expect.objectContaining({ companyId: COMPANY_ID }),
    );
  });
});
