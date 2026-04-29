import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jitTelegramWebhookRoutes } from "../routes/jit-telegram-webhook.js";

// ── Mock services ───────────────────────────────────────────────────

const mockUpdateStatus = vi.fn();
const mockGetById = vi.fn();
const mockAddComment = vi.fn();
const mockIssueUpdate = vi.fn();
const mockWakeup = vi.fn();
const mockApprove = vi.fn();
const mockReject = vi.fn();
const mockApprovalGetById = vi.fn();
const mockAgentGetById = vi.fn();

vi.mock("../services/jit-pre-approvals.js", () => ({
  jitPreApprovalService: () => ({
    updateStatus: mockUpdateStatus,
  }),
}));

vi.mock("../services/index.js", () => ({
  approvalService: () => ({
    approve: mockApprove,
    reject: mockReject,
    getById: mockApprovalGetById,
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
  }),
  agentService: () => ({
    getById: mockAgentGetById,
  }),
  issueService: () => ({
    getById: mockGetById,
    addComment: mockAddComment,
    update: mockIssueUpdate,
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
  mockWakeup.mockResolvedValue(undefined);
  mockAddComment.mockResolvedValue({ id: "comment-1", body: "test" });
  mockIssueUpdate.mockResolvedValue({ id: "issue-1", status: "todo" });
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
      role: "agent-web",
      issueId: "issue-1",
    });
    mockGetById.mockResolvedValue({
      id: "issue-1",
      status: "blocked",
      assigneeAgentId: "agent-1",
    });

    const app = createApp();
    const res = await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve:pre-1"))
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateStatus).toHaveBeenCalledWith("pre-1", "approved", "telegram:12345");

    // Should have called answerCallbackQuery
    const answerCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes("/answerCallbackQuery"));
    expect(answerCalls.length).toBe(1);
    const body = JSON.parse(answerCalls[0][1].body);
    expect(body.text).toContain("Approved");
  });

  it("posts comment and unblocks issue on SSH pre-approval approve", async () => {
    mockUpdateStatus.mockResolvedValue({
      id: "pre-1",
      status: "approved",
      target: "work.int",
      role: "agent-web",
      issueId: "issue-1",
    });
    mockGetById.mockResolvedValue({
      id: "issue-1",
      status: "blocked",
      assigneeAgentId: "agent-1",
    });

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve:pre-1"))
      .expect(200);

    // Should have posted a comment
    expect(mockAddComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("JIT SSH pre-approval approved"),
      {},
    );
    expect(mockAddComment.mock.calls[0][1]).toContain("work.int");
    expect(mockAddComment.mock.calls[0][1]).toContain("agent-web");

    // Should have set status to todo
    expect(mockIssueUpdate).toHaveBeenCalledWith("issue-1", { status: "todo" });

    // Should have woken the assigned agent
    expect(mockWakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      reason: "jit_pre_approval_approved",
      payload: expect.objectContaining({
        preApprovalId: "pre-1",
        issueId: "issue-1",
        target: "work.int",
      }),
    }));
  });

  it("does not unblock issue if not in blocked status", async () => {
    mockUpdateStatus.mockResolvedValue({
      id: "pre-1",
      status: "approved",
      target: "work.int",
      role: "agent-web",
      issueId: "issue-1",
    });
    mockGetById.mockResolvedValue({
      id: "issue-1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
    });

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve:pre-1"))
      .expect(200);

    // Comment should still be posted
    expect(mockAddComment).toHaveBeenCalled();

    // Should NOT transition status since it's not blocked
    expect(mockIssueUpdate).not.toHaveBeenCalled();

    // Should still wake the agent
    expect(mockWakeup).toHaveBeenCalled();
  });

  it("does not post comment or wake on rejection", async () => {
    mockUpdateStatus.mockResolvedValue({
      id: "pre-2",
      status: "rejected",
      target: "work.int",
      role: "agent-web",
      issueId: "issue-1",
    });

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(67890, "jit:reject:pre-2"))
      .expect(200);

    expect(mockUpdateStatus).toHaveBeenCalledWith("pre-2", "rejected", "telegram:67890");
    expect(mockAddComment).not.toHaveBeenCalled();
    expect(mockIssueUpdate).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
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

    const answerCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes("/answerCallbackQuery"));
    const body = JSON.parse(answerCalls[0][1].body);
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

    const answerCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes("/answerCallbackQuery"));
    const body = JSON.parse(answerCalls[0][1].body);
    expect(body.text).toContain("Already processed");
  });

  it("handles not-found pre-approval gracefully", async () => {
    mockUpdateStatus.mockRejectedValue(new Error("Pre-approval not found"));

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve:pre-1"))
      .expect(200);

    const answerCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.includes("/answerCallbackQuery"));
    const body = JSON.parse(answerCalls[0][1].body);
    expect(body.text).toContain("Not found");
  });

  it("wakes agent via payload.agentId for ad-hoc exec token approvals", async () => {
    // Ad-hoc exec token requests store the agent as payload.agentId (not requestedByAgentId).
    // The webhook should fall back to payload.agentId when requestedByAgentId is absent.
    mockApprovalGetById.mockResolvedValue({
      id: "exec-1",
      requestedByAgentId: null,
      payload: {
        target: "work.int",
        scopes: ["exec"],
        agentId: "agent-dani",
        // no requestedByAgentId, no assigneeAgentId
      },
    });
    mockAgentGetById.mockResolvedValue({
      id: "agent-dani",
      urlKey: "coo",
      adapterConfig: { authToken: "tok-123" },
    });

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve-exec:exec-1"))
      .expect(200);

    expect(mockApprove).toHaveBeenCalledWith("exec-1", "telegram:12345", expect.any(String));
    // Should wake via heartbeat since no originSessionKey/originGatewayPort
    expect(mockWakeup).toHaveBeenCalledWith("agent-dani", expect.objectContaining({
      reason: "jit_exec_token_approved",
    }));
  });

  it("logs warning when agentToWake resolves to null on exec token approval", async () => {
    // When no agent ID is available at all, the webhook should log a warning
    mockApprovalGetById.mockResolvedValue({
      id: "exec-2",
      requestedByAgentId: null,
      payload: {
        target: "work.int",
        scopes: ["exec"],
        // no agentId, no requestedByAgentId, no assigneeAgentId
      },
    });

    const app = createApp();
    await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve-exec:exec-2"))
      .expect(200);

    expect(mockApprove).toHaveBeenCalledWith("exec-2", "telegram:12345", expect.any(String));
    // No agent to wake — should NOT call wakeup
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("gracefully handles issue service failures during SSH approve", async () => {
    mockUpdateStatus.mockResolvedValue({
      id: "pre-1",
      status: "approved",
      target: "work.int",
      role: "agent-web",
      issueId: "issue-1",
    });
    mockGetById.mockRejectedValue(new Error("DB connection failed"));

    const app = createApp();
    const res = await request(app)
      .post("/api/telegram/jit-webhook")
      .send(callbackUpdate(12345, "jit:approve:pre-1"))
      .expect(200);

    // Approval still succeeds — the unblock failure is non-fatal
    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateStatus).toHaveBeenCalledWith("pre-1", "approved", "telegram:12345");
  });
});
