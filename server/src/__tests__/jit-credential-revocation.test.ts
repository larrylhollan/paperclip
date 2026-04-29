import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock services ───────────────────────────────────────────────────

const mockRevokeForIssue = vi.hoisted(() => vi.fn());
const mockRevokeIssuancesForIssue = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("../services/jit-pre-approvals.js", () => ({
  jitPreApprovalService: () => ({
    revokeForIssue: mockRevokeForIssue,
  }),
}));

vi.mock("../jit-issuance-store.js", () => ({
  revokeIssuancesForIssue: mockRevokeIssuancesForIssue,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
}));

// ── Import under test (after mocks) ────────────────────────────────

import { revokeCredentialsOnIssueClose } from "../services/jit-credential-revocation.js";

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

const db = {} as any;

// ── Tests ───────────────────────────────────────────────────────────

describe("revokeCredentialsOnIssueClose", () => {
  it("revokes active pre-approvals and unresolved issuances", async () => {
    mockRevokeForIssue.mockResolvedValue({
      revokedCount: 3,
      records: [{}, {}, {}],
    });
    mockRevokeIssuancesForIssue.mockResolvedValue(2);

    const result = await revokeCredentialsOnIssueClose(db, "issue-1", "done");

    expect(result).toEqual({ preApprovalsRevoked: 3, issuancesRevoked: 2 });
    expect(mockRevokeForIssue).toHaveBeenCalledWith("issue-1");
    expect(mockRevokeIssuancesForIssue).toHaveBeenCalledWith("issue-1");
  });

  it("logs when credentials are revoked", async () => {
    mockRevokeForIssue.mockResolvedValue({ revokedCount: 1, records: [{}] });
    mockRevokeIssuancesForIssue.mockResolvedValue(1);

    await revokeCredentialsOnIssueClose(db, "issue-2", "cancelled");

    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        issueId: "issue-2",
        newStatus: "cancelled",
        preApprovalsRevoked: 1,
        issuancesRevoked: 1,
      },
      "revoked JIT credentials on issue close",
    );
  });

  it("does not log when nothing is revoked", async () => {
    mockRevokeForIssue.mockResolvedValue({ revokedCount: 0, records: [] });
    mockRevokeIssuancesForIssue.mockResolvedValue(0);

    const result = await revokeCredentialsOnIssueClose(db, "issue-3", "done");

    expect(result).toEqual({ preApprovalsRevoked: 0, issuancesRevoked: 0 });
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it("returns correct counts when only pre-approvals are revoked", async () => {
    mockRevokeForIssue.mockResolvedValue({ revokedCount: 2, records: [{}, {}] });
    mockRevokeIssuancesForIssue.mockResolvedValue(0);

    const result = await revokeCredentialsOnIssueClose(db, "issue-4", "done");

    expect(result).toEqual({ preApprovalsRevoked: 2, issuancesRevoked: 0 });
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it("returns correct counts when only issuances are revoked", async () => {
    mockRevokeForIssue.mockResolvedValue({ revokedCount: 0, records: [] });
    mockRevokeIssuancesForIssue.mockResolvedValue(3);

    const result = await revokeCredentialsOnIssueClose(db, "issue-5", "cancelled");

    expect(result).toEqual({ preApprovalsRevoked: 0, issuancesRevoked: 3 });
    expect(mockLogger.info).toHaveBeenCalled();
  });

  it("propagates errors (caller is responsible for catching)", async () => {
    mockRevokeForIssue.mockRejectedValue(new Error("DB down"));
    mockRevokeIssuancesForIssue.mockResolvedValue(0);

    await expect(
      revokeCredentialsOnIssueClose(db, "issue-6", "done"),
    ).rejects.toThrow("DB down");
  });

  it("runs both revocations in parallel", async () => {
    const order: string[] = [];
    mockRevokeForIssue.mockImplementation(async () => {
      order.push("preApprovals-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("preApprovals-end");
      return { revokedCount: 0, records: [] };
    });
    mockRevokeIssuancesForIssue.mockImplementation(async () => {
      order.push("issuances-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("issuances-end");
      return 0;
    });

    await revokeCredentialsOnIssueClose(db, "issue-7", "done");

    // Both should start before either ends (parallel execution)
    expect(order.indexOf("preApprovals-start")).toBeLessThan(order.indexOf("preApprovals-end"));
    expect(order.indexOf("issuances-start")).toBeLessThan(order.indexOf("issuances-end"));
    // Both start before either finishes
    const firstEnd = Math.min(order.indexOf("preApprovals-end"), order.indexOf("issuances-end"));
    expect(order.indexOf("preApprovals-start")).toBeLessThan(firstEnd);
    expect(order.indexOf("issuances-start")).toBeLessThan(firstEnd);
  });
});
