import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jitTelegramWebhookRoutes } from "../routes/jit-telegram-webhook.js";

// ── Mock services ───────────────────────────────────────────────────

const mockUpdateStatus = vi.fn();

vi.mock("../services/jit-pre-approvals.js", () => ({
  jitPreApprovalService: () => ({
    updateStatus: mockUpdateStatus,
  }),
}));

vi.mock("../services/jit-notification.js", () => ({
  getJitApprovalBotToken: () => "test-bot-token",
  getAllowedUserIds: () => new Set((process.env.JIT_APPROVAL_ALLOWED_USER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean)),
  editMessageReplyMarkupWithBot: vi.fn(async () => undefined),
}));

// ── Mock global fetch (for answerCallbackQuery calls) ───────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Test app ─────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", jitTelegramWebhookRoutes({} as any));
  return app;
}

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true }),
  });
  // Set allowed user IDs via env before importing
  process.env.JIT_APPROVAL_ALLOWED_USER_IDS = "12345,67890";
});

afterEach(() => {
  delete process.env.JIT_APPROVAL_ALLOWED_USER_IDS;
});

// ── Helpers ──────────────────────────────────────────────────────────

function callbackUpdate(userId: number, data: string, cbqId = "cbq-1") {
  return {
    callback_query: {
      id: cbqId,
      from: { id: userId },
      data,
      message: { message_id: 999, chat: { id: -1001234 } },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("POST /api/telegram/jit-webhook", () => {
  it("approves a valid callback", async () => {
    mockUpdateStatus.mockResolvedValue({
      id: "pre-1",
      status: "approved",
      target: "work.int",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve:pre-1"))
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateStatus).toHaveBeenCalledWith("pre-1", "approved", "telegram:12345");

    // Should have called answerCallbackQuery
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/answerCallbackQuery");
    const body = JSON.parse(opts.body);
    expect(body.text).toContain("Approved");
  });

  it("rejects a valid callback", async () => {
    mockUpdateStatus.mockResolvedValue({
      id: "pre-2",
      status: "rejected",
      target: "work.int",
    });

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(67890, "jit:reject:pre-2"))
      .expect(200);

    expect(mockUpdateStatus).toHaveBeenCalledWith("pre-2", "rejected", "telegram:67890");

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.text).toContain("Rejected");
  });

  it("returns 200 with 'Not authorized' for unauthorized user", async () => {
    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(99999, "jit:approve:pre-1"))
      .expect(200);

    expect(mockUpdateStatus).not.toHaveBeenCalled();

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.text).toContain("Not authorized");
  });

  it("returns 200 and ignores invalid callback_data format", async () => {
    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "invalid:data"))
      .expect(200);

    expect(mockUpdateStatus).not.toHaveBeenCalled();

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.text).toBe("Unknown action");
  });

  it("returns 200 when no callback_query in update", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/telegram/jit-webhook")
      .send({ message: { text: "hello" } })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles already-processed pre-approval gracefully", async () => {
    mockUpdateStatus.mockRejectedValue(
      new Error("Only pending pre-approvals can be approved or rejected"),
    );

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve:pre-1"))
      .expect(200);

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.text).toContain("Already processed");
  });

  it("handles not-found pre-approval gracefully", async () => {
    mockUpdateStatus.mockRejectedValue(new Error("Pre-approval not found"));

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve:pre-1"))
      .expect(200);

    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.text).toContain("Not found");
  });
});
