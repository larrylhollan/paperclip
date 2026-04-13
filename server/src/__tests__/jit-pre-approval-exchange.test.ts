import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jitPreApprovalRoutes } from "../routes/jit-pre-approvals.js";
import { errorHandler } from "../middleware/index.js";
import { resetJitTargetRegistryCache } from "../jit-target-registry.js";
import { _clearIssuanceStore } from "../jit-issuance-store.js";

// ── Mock services ───────────────────────────────────────────────────

const mockPreApprovalService = vi.hoisted(() => ({
  exchange: vi.fn(),
  renew: vi.fn(),
  createForIssue: vi.fn(),
  listForIssue: vi.fn(),
  getById: vi.fn(),
  updateStatus: vi.fn(),
  expireStale: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("../services/jit-pre-approvals.js", () => ({
  jitPreApprovalService: () => mockPreApprovalService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

const mockQueueJitNotification = vi.hoisted(() => vi.fn());

vi.mock("../services/jit-notification.js", () => ({
  sendRenewalNotification: vi.fn(async () => undefined),
  verifyAction: vi.fn(),
  getHmacSecret: vi.fn(),
  editAfterQuickAction: vi.fn(async () => undefined),
  queueJitNotification: mockQueueJitNotification,
}));

// ── Mock global fetch ───────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock auth middleware ─────────────────────────────────────────────

vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));

// ── Test app ─────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(jitPreApprovalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// ── Fixtures ─────────────────────────────────────────────────────────

const RECORD_APPROVED = {
  id: "aaaa-bbbb",
  issueId: "issue-1",
  target: "work.int",
  role: "agent",
  status: "approved",
  expiresAt: new Date(Date.now() + 86400000),
  renewalCount: 0,
  approvedByUserId: "user-jeff",
  approvedAt: new Date("2026-03-30T19:00:00Z"),
};

const RECORD_EXCHANGED = {
  ...RECORD_APPROVED,
  status: "exchanged",
  exchangedAt: new Date(),
  credentialExpiresAt: new Date(Date.now() + 7200000),
  renewalCount: 0,
};

const RECORD_RENEWED = {
  ...RECORD_EXCHANGED,
  renewalCount: 1,
  credentialExpiresAt: new Date(Date.now() + 7200000),
};

const SIGNER_RESPONSE = {
  fetch_url: "https://agent-access.example.com/fetch/xyz",
  ssh_host: "work.int.hollan.dev",
  ssh_user: "agent",
  principal: "agent",
  cert_id: "cert-abc",
  ttl_minutes: 60,
  issued_at: "2026-03-30T20:00:00Z",
  expires_at: "2026-03-30T21:00:00Z",
};

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetJitTargetRegistryCache();
  _clearIssuanceStore();
  // Set up the target registry via env
  process.env.AGENT_ACCESS_BASE_URL = "https://agent-access.example.com";
  process.env.AGENT_ACCESS_BEARER_TOKEN = "test-token";
});

afterEach(() => {
  delete process.env.AGENT_ACCESS_BASE_URL;
  delete process.env.AGENT_ACCESS_BEARER_TOKEN;
  delete process.env.JIT_TARGET_REGISTRY;
  resetJitTargetRegistryCache();
  _clearIssuanceStore();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("POST /issues/:id/jit-pre-approvals", () => {
  const ISSUE = {
    id: "issue-1",
    identifier: "ENG-100",
    title: "Test issue",
    parentId: null,
    companyId: "company-1",
  };

  const CREATED_RECORDS = [
    { id: "rec-1", issueId: "issue-1", target: "work.int", role: "agent", reason: "deploy", status: "pending" },
  ];

  it("calls queueJitNotification after creating records", async () => {
    mockIssueService.getById.mockResolvedValue(ISSUE);
    mockPreApprovalService.createForIssue.mockResolvedValue(CREATED_RECORDS);

    const app = createApp();
    const res = await request(app)
      .post("/issues/issue-1/jit-pre-approvals")
      .send({ records: [{ target: "work.int", role: "agent", reason: "deploy" }] })
      .expect(201);

    expect(res.body).toEqual(CREATED_RECORDS);
    expect(mockQueueJitNotification).toHaveBeenCalledOnce();
    expect(mockQueueJitNotification).toHaveBeenCalledWith({}, ISSUE, CREATED_RECORDS);
  });

  it("returns 404 and does not notify when issue is not found", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const app = createApp();
    await request(app)
      .post("/issues/missing/jit-pre-approvals")
      .send({ records: [{ target: "work.int", role: "agent", reason: "deploy" }] })
      .expect(404);

    expect(mockQueueJitNotification).not.toHaveBeenCalled();
    expect(mockPreApprovalService.createForIssue).not.toHaveBeenCalled();
  });
});

describe("POST /jit-pre-approvals/:id/exchange", () => {
  it("returns credential fields when sign-for-issue succeeds", async () => {
    mockPreApprovalService.exchange.mockResolvedValue(RECORD_EXCHANGED);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => SIGNER_RESPONSE,
    });

    const app = createApp();
    const res = await request(app)
      .post("/jit-pre-approvals/aaaa-bbbb/exchange")
      .send({ runId: "run-1" })
      .expect(200);

    expect(res.body.fetch_url).toBe(SIGNER_RESPONSE.fetch_url);
    expect(res.body.ssh_host).toBe(SIGNER_RESPONSE.ssh_host);
    expect(res.body.ssh_user).toBe(SIGNER_RESPONSE.ssh_user);
    expect(res.body.cert_id).toBe(SIGNER_RESPONSE.cert_id);
    expect(res.body.principal).toBe("agent");
    expect(res.body.ttl_minutes).toBe(60);
    expect(res.body.issued_at).toBe(SIGNER_RESPONSE.issued_at);
    expect(res.body.expires_at).toBe(SIGNER_RESPONSE.expires_at);
    // DB record fields still present
    expect(res.body.status).toBe("exchanged");
    expect(res.body.target).toBe("work.int");

    // Verify sign-for-issue was called with correct payload
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://agent-access.example.com/sign-for-issue");
    const body = JSON.parse(opts.body);
    expect(body.target).toBe("work.int");
    expect(body.principal).toBe("agent");
    expect(body.issueId).toBe("issue-1");
    expect(opts.headers.Authorization).toBe("Bearer test-token");
  });

  it("returns DB record without credentials when sign-for-issue fails", async () => {
    mockPreApprovalService.exchange.mockResolvedValue(RECORD_EXCHANGED);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const app = createApp();
    const res = await request(app)
      .post("/jit-pre-approvals/aaaa-bbbb/exchange")
      .send({ runId: "run-1" })
      .expect(200);

    expect(res.body.status).toBe("exchanged");
    expect(res.body.target).toBe("work.int");
    expect(res.body.fetch_url).toBeUndefined();
    expect(res.body.ssh_host).toBeUndefined();
  });

  it("returns DB record when target is not in registry", async () => {
    // Clear the registry so no targets are registered
    delete process.env.AGENT_ACCESS_BASE_URL;
    resetJitTargetRegistryCache();

    const record = { ...RECORD_EXCHANGED, target: "unknown-host" };
    mockPreApprovalService.exchange.mockResolvedValue(record);

    const app = createApp();
    const res = await request(app)
      .post("/jit-pre-approvals/aaaa-bbbb/exchange")
      .send({ runId: "run-1" })
      .expect(200);

    expect(res.body.status).toBe("exchanged");
    expect(res.body.fetch_url).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns DB record when fetch throws a network error", async () => {
    mockPreApprovalService.exchange.mockResolvedValue(RECORD_EXCHANGED);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const app = createApp();
    const res = await request(app)
      .post("/jit-pre-approvals/aaaa-bbbb/exchange")
      .send({ runId: "run-1" })
      .expect(200);

    expect(res.body.status).toBe("exchanged");
    expect(res.body.fetch_url).toBeUndefined();
  });

  it("includes approvalTicket in sign-for-issue when AGENT_ACCESS_TICKET_SECRET is set", async () => {
    process.env.AGENT_ACCESS_TICKET_SECRET = "test-ticket-secret";
    mockPreApprovalService.exchange.mockResolvedValue(RECORD_EXCHANGED);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => SIGNER_RESPONSE,
    });

    const app = createApp();
    await request(app)
      .post("/jit-pre-approvals/aaaa-bbbb/exchange")
      .send({ runId: "run-1" })
      .expect(200);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.approvalTicket).toBeDefined();
    expect(body.approvalTicket.approvalId).toBe("aaaa-bbbb");
    expect(body.approvalTicket.issueId).toBe("issue-1");
    expect(body.approvalTicket.approvedByUserId).toBe("user-jeff");
    expect(body.approvalTicket.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(body.approvalTicket.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.approvalTicket.expiresAt).toBeDefined();

    delete process.env.AGENT_ACCESS_TICKET_SECRET;
  });

  it("does not include approvalTicket when AGENT_ACCESS_TICKET_SECRET is not set", async () => {
    delete process.env.AGENT_ACCESS_TICKET_SECRET;
    mockPreApprovalService.exchange.mockResolvedValue(RECORD_EXCHANGED);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => SIGNER_RESPONSE,
    });

    const app = createApp();
    await request(app)
      .post("/jit-pre-approvals/aaaa-bbbb/exchange")
      .send({ runId: "run-1" })
      .expect(200);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.approvalTicket).toBeUndefined();
  });
});

describe("POST /jit-pre-approvals/:id/renew", () => {
  it("returns credential fields when sign-for-issue succeeds", async () => {
    mockPreApprovalService.renew.mockResolvedValue(RECORD_RENEWED);
    mockIssueService.getById.mockResolvedValue({ identifier: "ENG-42" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => SIGNER_RESPONSE,
    });

    const app = createApp();
    const res = await request(app)
      .post("/jit-pre-approvals/aaaa-bbbb/renew")
      .send()
      .expect(200);

    expect(res.body.fetch_url).toBe(SIGNER_RESPONSE.fetch_url);
    expect(res.body.ssh_host).toBe(SIGNER_RESPONSE.ssh_host);
    expect(res.body.renewalCount).toBe(1);
    expect(res.body.status).toBe("exchanged");
  });

  it("returns DB record without credentials when sign-for-issue fails", async () => {
    mockPreApprovalService.renew.mockResolvedValue(RECORD_RENEWED);
    mockIssueService.getById.mockResolvedValue({ identifier: "ENG-42" });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    });

    const app = createApp();
    const res = await request(app)
      .post("/jit-pre-approvals/aaaa-bbbb/renew")
      .send()
      .expect(200);

    expect(res.body.renewalCount).toBe(1);
    expect(res.body.fetch_url).toBeUndefined();
  });
});
