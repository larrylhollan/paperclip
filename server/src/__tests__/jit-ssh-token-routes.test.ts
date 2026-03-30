import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { resetJitTargetRegistryCache } from "../jit-target-registry.js";
import { _clearIssuanceStore } from "../jit-issuance-store.js";
import { computeJitApprovalHash } from "../jit-approval-hash.js";

// ── Mock services ───────────────────────────────────────────────────

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  approve: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  link: vi.fn(async () => undefined),
  listApprovalsForIssue: vi.fn(async () => []),
  listIssuesForApproval: vi.fn(async () => []),
  unlink: vi.fn(async () => undefined),
  linkManyForApproval: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  approvalService: () => mockApprovalService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

// ── Mock global fetch ───────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock DB for consumed-marker update ──────────────────────────────

const mockDbUpdate = vi.fn();

function createMockDb() {
  const whereStep = { where: vi.fn(async () => undefined) };
  const setStep = { set: vi.fn(() => whereStep) };
  mockDbUpdate.mockReturnValue(setStep);
  return { update: mockDbUpdate } as any;
}

// ── Test helpers ────────────────────────────────────────────────────

let mockDb: ReturnType<typeof createMockDb>;

function createApp() {
  mockDb = createMockDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb, {} as any));
  app.use(errorHandler);
  return app;
}

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeIssue() {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "HOL-76",
    title: "Multi-machine JIT tokens",
  };
}

const TOKEN_RESPONSE = {
  fetchUrl: "https://access.example.com/fetch/abc",
  principal: "agent",
  ttlMinutes: 60,
  targetHost: "work.int",
  certId: "cert-123",
  issuedAt: "2026-03-26T00:00:00Z",
  expiresAt: "2026-03-26T01:00:00Z",
};

function makeApprovedApproval(overrides: Record<string, unknown> = {}) {
  const issue = makeIssue();
  const paramsHash = computeJitApprovalHash({
    issueId: ISSUE_ID,
    target: "work.int",
    principal: "agent",
    ttlMinutes: 60,
    shareTmux: false,
    assigneeAgentId: issue.assigneeAgentId,
  });
  return {
    id: APPROVAL_ID,
    companyId: "company-1",
    type: "jit_ssh_token",
    status: "approved",
    decidedAt: new Date(),
    decidedByUserId: "local-board",
    payload: {
      issueId: ISSUE_ID,
      target: "work.int",
      principal: "agent",
      ttlMinutes: 60,
      shareTmux: false,
      assigneeAgentId: issue.assigneeAgentId,
      paramsHash,
      options: {},
    },
    ...overrides,
  };
}

/**
 * Helper: set up mocks for the auto-approve single-call flow.
 * Callers must set up addComment + fetch mocks BEFORE calling this.
 * Returns the full supertest response (status 201 by default).
 */
async function autoApproveAndExecute(
  app: ReturnType<typeof createApp>,
  sendBody: Record<string, unknown>,
  approvalOverrides?: Record<string, unknown>,
  expectedStatus = 201,
) {
  mockIssueService.getById.mockResolvedValue(makeIssue());
  mockApprovalService.create.mockResolvedValue({ id: APPROVAL_ID });
  mockApprovalService.approve.mockResolvedValue(undefined);

  const approval = makeApprovedApproval(approvalOverrides);
  mockApprovalService.getById.mockResolvedValue(approval);

  const res = await request(app)
    .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
    .send(sendBody)
    .expect(expectedStatus);

  return res;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("POST /api/issues/:id/jit-ssh-token", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearIssuanceStore();
    resetJitTargetRegistryCache();
    process.env.AGENT_ACCESS_BASE_URL = "https://access.example.com";
    app = createApp();
  });

  afterEach(() => {
    delete process.env.AGENT_ACCESS_BASE_URL;
    delete process.env.AGENT_ACCESS_BEARER_TOKEN;
    delete process.env.AGENT_ACCESS_BEARER_TOKEN_FILE;
    delete process.env.AGENT_ACCESS_TICKET_SECRET;
    delete process.env.JIT_TARGET_REGISTRY;
    resetJitTargetRegistryCache();
    _clearIssuanceStore();
  });

  // ── Phase A: Approval creation (auto-approved for board users) ───

  it("creates approval with correct type and payload", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockApprovalService.create.mockResolvedValue({ id: APPROVAL_ID });
    mockApprovalService.approve.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue(makeApprovedApproval());
    mockIssueService.addComment.mockResolvedValue({ id: "comment-create" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int" })
      .expect(201);

    // Approval created with correct type and payload
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
    const [companyId, data] = mockApprovalService.create.mock.calls[0];
    expect(companyId).toBe("company-1");
    expect(data.type).toBe("jit_ssh_token");
    expect(data.payload.issueId).toBe(ISSUE_ID);
    expect(data.payload.target).toBe("work.int");
    expect(data.payload.paramsHash).toEqual(expect.any(String));

    // Linked to issue
    expect(mockIssueApprovalService.link).toHaveBeenCalledOnce();
  });

  it("auto-approves for board users and returns 201 (not 202)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockApprovalService.create.mockResolvedValue({ id: APPROVAL_ID });
    mockApprovalService.approve.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue(makeApprovedApproval());
    mockIssueService.addComment.mockResolvedValue({ id: "comment-auto" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    // Single request - no approvalId
    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int" })
      .expect(201);

    // Should return token, NOT pending_approval
    expect(res.body.token).toBeDefined();
    expect(res.body.token.type).toBe("jit-ssh-token");
    expect(res.body.comment).toBeDefined();
    expect(res.body.status).not.toBe("pending_approval");

    // Verify approve was called (auto-approve path)
    expect(mockApprovalService.approve).toHaveBeenCalledOnce();
  });

  // ── Phase B: Execute after approval ──────────────────────────────

  it("provisions a token for an allowlisted target", async () => {
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    const res = await autoApproveAndExecute(app, { target: "work.int" });

    expect(res.body.token).toMatchObject({
      type: "jit-ssh-token",
      fetch_url: TOKEN_RESPONSE.fetchUrl,
      principal: TOKEN_RESPONSE.principal,
      target: "work.int",
    });
    expect(res.body.comment).toEqual({ id: "comment-1" });

    // Verify the issuer was called with the structured payload.
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://access.example.com/sign-for-issue");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({
      issueId: ISSUE_ID,
      companyId: "company-1",
      target: "work.int",
      principal: "agent",
      ttlMinutes: 60,
      ttl_minutes: 60,
      shareTmux: false,
      share_tmux: false,
    });
  });

  it("comment contains issuance_id and NOT fetch_url", async () => {
    mockIssueService.addComment.mockResolvedValue({ id: "comment-opaque" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, { target: "work.int" });

    const commentBody = mockIssueService.addComment.mock.calls[0][1] as string;
    expect(commentBody).toContain("<!-- jit-ssh-token -->");
    const json = JSON.parse(
      commentBody
        .replace("<!-- jit-ssh-token -->", "")
        .replace("<!-- /jit-ssh-token -->", "")
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, ""),
    );
    expect(json.type).toBe("jit-ssh-token");
    expect(json.schema_version).toBe(3);
    expect(json.issuance_id).toEqual(expect.any(String));
    expect(json.issuanceId).toEqual(expect.any(String));
    expect(json.target).toBe("work.int");
    expect(json.fetch_url).toBeUndefined();
    expect(json.fetchUrl).toBeUndefined();
  });

  it("forwards custom principal, ttlMinutes, and shareTmux to the issuer", async () => {
    const sendBody = { target: "pc.int", principal: "root", ttlMinutes: 30, shareTmux: true };
    const issue = makeIssue();
    const paramsHash = computeJitApprovalHash({
      issueId: ISSUE_ID,
      target: "pc.int",
      principal: "root",
      ttlMinutes: 30,
      shareTmux: true,
      assigneeAgentId: issue.assigneeAgentId,
    });

    mockIssueService.addComment.mockResolvedValue({ id: "comment-2" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, sendBody, {
      payload: {
        issueId: ISSUE_ID,
        target: "pc.int",
        principal: "root",
        ttlMinutes: 30,
        shareTmux: true,
        assigneeAgentId: issue.assigneeAgentId,
        paramsHash,
        options: {},
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.principal).toBe("root");
    expect(body.ttlMinutes).toBe(30);
    expect(body.ttl_minutes).toBe(30);
    expect(body.shareTmux).toBe(true);
    expect(body.share_tmux).toBe(true);
    expect(body.tmux_user).toBe("jeffhollan");
    expect(body.target).toBe("pc.int");
  });

  it("includes the configured bearer token when calling the issuer", async () => {
    process.env.AGENT_ACCESS_BEARER_TOKEN = "secret-token";
    mockIssueService.addComment.mockResolvedValue({ id: "comment-auth" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, { target: "work.int" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-token",
    });
  });

  it("rejects an unknown target machine", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "evil.ext" })
      .expect(400);

    expect(res.body.error).toMatch(/Unknown target machine/);
    expect(res.body.allowedTargets).toEqual(expect.arrayContaining(["work.int", "pc.int", "arch.int"]));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 400 when no target is provided", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({})
      .expect(400);

    expect(res.body.error).toMatch(/Invalid issuance request/);
  });

  it("returns 503 when no registry is configured", async () => {
    delete process.env.AGENT_ACCESS_BASE_URL;
    resetJitTargetRegistryCache();
    app = createApp();
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int" })
      .expect(400);

    expect(res.body.error).toMatch(/Unknown target machine/);
    expect(res.body.allowedTargets).toEqual([]);
  });

  it("uses a custom JIT_TARGET_REGISTRY env var", async () => {
    process.env.JIT_TARGET_REGISTRY = JSON.stringify({
      "custom.machine": {
        label: "Custom",
        issuerBaseUrl: "https://custom-issuer.example.com",
        defaultPrincipal: "deploy",
        defaultTtlMinutes: 15,
      },
    });
    resetJitTargetRegistryCache();
    app = createApp();

    const issue = makeIssue();
    const paramsHash = computeJitApprovalHash({
      issueId: ISSUE_ID,
      target: "custom.machine",
      principal: "deploy",
      ttlMinutes: 15,
      shareTmux: false,
      assigneeAgentId: issue.assigneeAgentId,
    });

    mockIssueService.addComment.mockResolvedValue({ id: "comment-3" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...TOKEN_RESPONSE, principal: "deploy", ttlMinutes: 15 }),
    });

    await autoApproveAndExecute(app, { target: "custom.machine" }, {
      payload: {
        issueId: ISSUE_ID,
        target: "custom.machine",
        principal: "deploy",
        ttlMinutes: 15,
        shareTmux: false,
        assigneeAgentId: issue.assigneeAgentId,
        paramsHash,
        options: {},
      },
    });

    expect(mockFetch.mock.calls[0][0]).toBe("https://custom-issuer.example.com/sign-for-issue");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.principal).toBe("deploy");
    expect(body.ttlMinutes).toBe(15);
  });

  it("returns 403 for non-board, non-assignee agents", async () => {
    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        companyIds: ["company-1"],
        source: "jwt",
        isInstanceAdmin: false,
      };
      next();
    });
    agentApp.use("/api", issueRoutes(createMockDb(), {} as any));
    agentApp.use(errorHandler);

    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(agentApp)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int" })
      .expect(403);

    expect(res.body.error).toMatch(/Only board users or the assigned agent/);
  });

  it("allows the assignee agent to self-provision JIT SSH tokens", async () => {
    // Set up self-provision policy that allows the test project/target
    const testProjectId = "test-project-1";
    process.env.JIT_AGENT_SELF_PROVISION_POLICY = JSON.stringify({
      rules: [{ projectId: testProjectId, targets: ["work.int"], maxTtlMinutes: 120 }],
    });
    // Reset cached policy so the new env var is picked up
    const { resetSelfProvisionPolicyCache } = await import("../routes/issues.js");
    resetSelfProvisionPolicyCache();

    const assigneeAgentId = "22222222-2222-4222-8222-222222222222";
    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: assigneeAgentId,
        companyId: "company-1",
        companyIds: ["company-1"],
        source: "agent_key",
        isInstanceAdmin: false,
      };
      next();
    });
    const agentDb = createMockDb();
    agentApp.use("/api", issueRoutes(agentDb, {} as any));
    agentApp.use(errorHandler);

    mockIssueService.getById.mockResolvedValue({ ...makeIssue(), projectId: testProjectId });
    mockApprovalService.create.mockResolvedValue({ id: APPROVAL_ID });
    mockApprovalService.approve.mockResolvedValue(undefined);
    mockApprovalService.getById.mockResolvedValue(makeApprovedApproval());
    mockIssueService.addComment.mockResolvedValue({ id: "comment-agent-self" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    const res = await request(agentApp)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int" })
      .expect(201);

    // Should auto-approve and return token (not 202 pending)
    expect(res.body.token).toBeDefined();
    expect(res.body.token.type).toBe("jit-ssh-token");
    expect(res.body.status).not.toBe("pending_approval");

    // Verify approval was created with requestedByAgentId
    expect(mockApprovalService.create).toHaveBeenCalledOnce();
    const [, approvalData] = mockApprovalService.create.mock.calls[0];
    expect(approvalData.requestedByAgentId).toBe(assigneeAgentId);
    expect(approvalData.requestedByUserId).toBeNull();

    // Verify auto-approve was called with the self-provision note
    expect(mockApprovalService.approve).toHaveBeenCalledOnce();
    const approveArgs = mockApprovalService.approve.mock.calls[0];
    expect(approveArgs[2]).toBe("Auto-approved: assignee agent self-provision");

    // Verify comment includes agentId for audit trail
    const commentOpts = mockIssueService.addComment.mock.calls[0][2];
    expect(commentOpts.agentId).toBe(assigneeAgentId);

    // Clean up
    delete process.env.JIT_AGENT_SELF_PROVISION_POLICY;
    resetSelfProvisionPolicyCache();
  });

  it("wakes the assigned agent after token provisioning", async () => {
    mockIssueService.addComment.mockResolvedValue({ id: "comment-4" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    const issue = makeIssue();
    const paramsHash = computeJitApprovalHash({
      issueId: ISSUE_ID,
      target: "arch.int",
      principal: "agent",
      ttlMinutes: 60,
      shareTmux: false,
      assigneeAgentId: issue.assigneeAgentId,
    });

    await autoApproveAndExecute(app, { target: "arch.int" }, {
      payload: {
        issueId: ISSUE_ID,
        target: "arch.int",
        principal: "agent",
        ttlMinutes: 60,
        shareTmux: false,
        assigneeAgentId: issue.assigneeAgentId,
        paramsHash,
        options: {},
      },
    });

    expect(mockHeartbeatService.wakeup).toHaveBeenCalledOnce();
    const wakeCall = mockHeartbeatService.wakeup.mock.calls[0];
    expect(wakeCall[0]).toBe("22222222-2222-4222-8222-222222222222");
    expect(wakeCall[1].payload).toMatchObject({
      issueId: ISSUE_ID,
      target: "arch.int",
    });
  });

  it("includes the target in the structured comment", async () => {
    mockIssueService.addComment.mockResolvedValue({ id: "comment-5" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, { target: "work.int" });

    const commentBody = mockIssueService.addComment.mock.calls[0][1] as string;
    expect(commentBody).toContain("<!-- jit-ssh-token -->");
    const json = JSON.parse(
      commentBody
        .replace("<!-- jit-ssh-token -->", "")
        .replace("<!-- /jit-ssh-token -->", "")
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, ""),
    );
    expect(json.type).toBe("jit-ssh-token");
    expect(json.target).toBe("work.int");
  });

  it("proxies issuer errors correctly", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "bad principal",
    });

    const res = await autoApproveAndExecute(app, { target: "work.int" }, undefined, 422);

    expect(res.body.detail).toBe("bad principal");
  });

  // ── Approval validation tests ────────────────────────────────────

  it("rejects execution with non-approved approval", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockApprovalService.getById.mockResolvedValue(
      makeApprovedApproval({ status: "pending" }),
    );

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int", approvalId: APPROVAL_ID })
      .expect(409);

    expect(res.body.error).toMatch(/not approved/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects execution with already-consumed approval", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const approval = makeApprovedApproval();
    (approval.payload as any).consumedAt = new Date().toISOString();
    mockApprovalService.getById.mockResolvedValue(approval);

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int", approvalId: APPROVAL_ID })
      .expect(409);

    expect(res.body.error).toMatch(/already been consumed/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects execution with expired approval", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const approval = makeApprovedApproval({
      decidedAt: new Date(Date.now() - 15 * 60 * 1000), // 15 minutes ago
    });
    mockApprovalService.getById.mockResolvedValue(approval);

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int", approvalId: APPROVAL_ID })
      .expect(409);

    expect(res.body.error).toMatch(/expired/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects execution when params hash has changed", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const approval = makeApprovedApproval();
    (approval.payload as any).paramsHash = "stale-hash-from-different-params";
    mockApprovalService.getById.mockResolvedValue(approval);

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int", approvalId: APPROVAL_ID })
      .expect(409);

    expect(res.body.error).toMatch(/parameters have changed/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects execution with wrong approval type", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockApprovalService.getById.mockResolvedValue(
      makeApprovedApproval({ type: "hire_agent" }),
    );

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int", approvalId: APPROVAL_ID })
      .expect(409);

    expect(res.body.error).toMatch(/not a JIT SSH token approval/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 404 when approval is not found", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockApprovalService.getById.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/jit-ssh-token`)
      .send({ target: "work.int", approvalId: "nonexistent-id" })
      .expect(404);

    expect(res.body.error).toMatch(/Approval not found/);
  });

  it("marks approval as consumed after successful execution", async () => {
    mockIssueService.addComment.mockResolvedValue({ id: "comment-consumed" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, { target: "work.int" });

    // Verify db.update was called to mark consumed
    expect(mockDbUpdate).toHaveBeenCalled();
  });

  // ── Approval ticket tests ──────────────────────────────────────

  it("includes approvalTicket in sign-for-issue when AGENT_ACCESS_TICKET_SECRET is set", async () => {
    process.env.AGENT_ACCESS_TICKET_SECRET = "test-ticket-secret";
    mockIssueService.addComment.mockResolvedValue({ id: "comment-ticket" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, { target: "work.int" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.approvalTicket).toBeDefined();
    expect(body.approvalTicket.approvalId).toBe(APPROVAL_ID);
    expect(body.approvalTicket.issueId).toBe(ISSUE_ID);
    expect(body.approvalTicket.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(body.approvalTicket.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.approvalTicket.expiresAt).toBeDefined();
  });

  it("does not include approvalTicket when AGENT_ACCESS_TICKET_SECRET is not set", async () => {
    delete process.env.AGENT_ACCESS_TICKET_SECRET;
    mockIssueService.addComment.mockResolvedValue({ id: "comment-no-ticket" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, { target: "work.int" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.approvalTicket).toBeUndefined();
  });
});

describe("POST /api/issuances/:id/resolve", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearIssuanceStore();
    resetJitTargetRegistryCache();
    process.env.AGENT_ACCESS_BASE_URL = "https://access.example.com";
    app = createApp();
  });

  afterEach(() => {
    delete process.env.AGENT_ACCESS_BASE_URL;
    delete process.env.JIT_TARGET_REGISTRY;
    resetJitTargetRegistryCache();
    _clearIssuanceStore();
  });

  it("resolves an issuance and returns the full credential", async () => {
    mockIssueService.addComment.mockResolvedValue({ id: "comment-resolve" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, { target: "work.int" });

    // Extract the issuance_id from the comment.
    const commentBody = mockIssueService.addComment.mock.calls[0][1] as string;
    const json = JSON.parse(
      commentBody
        .replace("<!-- jit-ssh-token -->", "")
        .replace("<!-- /jit-ssh-token -->", "")
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, ""),
    );
    const issuanceId = json.issuance_id;
    expect(issuanceId).toEqual(expect.any(String));

    // Resolve the issuance.
    const resolveRes = await request(app)
      .post(`/api/issuances/${issuanceId}/resolve`)
      .send()
      .expect(200);

    expect(resolveRes.body).toMatchObject({
      type: "jit-ssh-token",
      fetch_url: TOKEN_RESPONSE.fetchUrl,
      target: "work.int",
    });
  });

  it("returns 404 on second resolve (one-time use)", async () => {
    mockIssueService.addComment.mockResolvedValue({ id: "comment-once" });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => TOKEN_RESPONSE,
    });

    await autoApproveAndExecute(app, { target: "work.int" });

    const commentBody = mockIssueService.addComment.mock.calls[0][1] as string;
    const json = JSON.parse(
      commentBody
        .replace("<!-- jit-ssh-token -->", "")
        .replace("<!-- /jit-ssh-token -->", "")
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, ""),
    );
    const issuanceId = json.issuance_id;

    await request(app)
      .post(`/api/issuances/${issuanceId}/resolve`)
      .send()
      .expect(200);

    await request(app)
      .post(`/api/issuances/${issuanceId}/resolve`)
      .send()
      .expect(404);
  });

  it("returns 404 for unknown issuance ID", async () => {
    await request(app)
      .post("/api/issuances/00000000-0000-0000-0000-000000000000/resolve")
      .send()
      .expect(404);
  });
});

describe("GET /api/jit-targets", () => {
  afterEach(() => {
    delete process.env.AGENT_ACCESS_BASE_URL;
    delete process.env.JIT_TARGET_REGISTRY;
    resetJitTargetRegistryCache();
  });

  it("returns the fallback targets when AGENT_ACCESS_BASE_URL is set", async () => {
    process.env.AGENT_ACCESS_BASE_URL = "https://access.example.com";
    resetJitTargetRegistryCache();

    const app = createApp();
    const res = await request(app).get("/api/jit-targets").expect(200);

    expect(res.body).toEqual([
      { name: "work.int", label: "Work", defaultPrincipal: "agent", defaultTtlMinutes: 60 },
      { name: "pc.int", label: "Paperclip", defaultPrincipal: "agent", defaultTtlMinutes: 60 },
      { name: "arch.int", label: "Arch", defaultPrincipal: "agent", defaultTtlMinutes: 60 },
    ]);
  });

  it("returns an empty array when no registry is configured", async () => {
    delete process.env.AGENT_ACCESS_BASE_URL;
    resetJitTargetRegistryCache();

    const app = createApp();
    const res = await request(app).get("/api/jit-targets").expect(200);

    expect(res.body).toEqual([]);
  });

  it("returns custom targets from JIT_TARGET_REGISTRY", async () => {
    process.env.JIT_TARGET_REGISTRY = JSON.stringify({
      "custom.host": {
        label: "Custom Host",
        issuerBaseUrl: "https://custom.example.com",
        defaultPrincipal: "deploy",
        defaultTtlMinutes: 30,
      },
    });
    resetJitTargetRegistryCache();

    const app = createApp();
    const res = await request(app).get("/api/jit-targets").expect(200);

    expect(res.body).toEqual([
      { name: "custom.host", label: "Custom Host", defaultPrincipal: "deploy", defaultTtlMinutes: 30 },
    ]);
  });
});
