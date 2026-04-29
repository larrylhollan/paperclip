import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateApprovalTicket,
  verifyApprovalTicket,
  type ApprovalTicket,
  type TicketParams,
} from "../jit-approval-ticket.js";

const TEST_SECRET = "test-secret-for-hol135";

const BASE_PARAMS: TicketParams = {
  approvalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  approvedByUserId: "user-jeff",
  issueId: "11111111-1111-4111-8111-111111111111",
  paramsHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  approvedAt: new Date("2026-03-27T12:00:00Z").toISOString(),
};

describe("jit-approval-ticket", () => {
  beforeEach(() => {
    process.env.AGENT_ACCESS_TICKET_SECRET = TEST_SECRET;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-27T12:05:00Z")); // 5 min after approval
  });

  afterEach(() => {
    delete process.env.AGENT_ACCESS_TICKET_SECRET;
    vi.useRealTimers();
  });

  it("generates a valid ticket and verifies successfully", () => {
    const ticket = generateApprovalTicket(BASE_PARAMS);

    expect(ticket.approvalId).toBe(BASE_PARAMS.approvalId);
    expect(ticket.approvedByUserId).toBe(BASE_PARAMS.approvedByUserId);
    expect(ticket.issueId).toBe(BASE_PARAMS.issueId);
    expect(ticket.paramsHash).toBe(BASE_PARAMS.paramsHash);
    expect(ticket.approvedAt).toBe(BASE_PARAMS.approvedAt);
    expect(ticket.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(ticket.signature).toMatch(/^[0-9a-f]{64}$/);

    // expiresAt should be approvedAt + 10 minutes
    const expected = new Date(new Date(BASE_PARAMS.approvedAt).getTime() + 10 * 60 * 1000).toISOString();
    expect(ticket.expiresAt).toBe(expected);

    const result = verifyApprovalTicket(ticket, TEST_SECRET);
    expect(result).toEqual({ valid: true });
  });

  it("rejects an expired ticket", () => {
    const ticket = generateApprovalTicket(BASE_PARAMS);

    // Advance time past expiry (approvedAt + 10 min = 12:10, set to 12:11)
    vi.setSystemTime(new Date("2026-03-27T12:11:00Z"));

    const result = verifyApprovalTicket(ticket, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/expired/i);
  });

  it("rejects a tampered signature", () => {
    const ticket = generateApprovalTicket(BASE_PARAMS);
    const tampered: ApprovalTicket = { ...ticket, signature: "0".repeat(64) };

    const result = verifyApprovalTicket(tampered, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects wrong paramsHash (tampered field)", () => {
    const ticket = generateApprovalTicket(BASE_PARAMS);
    const tampered: ApprovalTicket = { ...ticket, paramsHash: "wrong-hash" };

    const result = verifyApprovalTicket(tampered, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects wrong issueId (tampered field)", () => {
    const ticket = generateApprovalTicket(BASE_PARAMS);
    const tampered: ApprovalTicket = { ...ticket, issueId: "wrong-issue-id" };

    const result = verifyApprovalTicket(tampered, TEST_SECRET);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects verification with wrong secret", () => {
    const ticket = generateApprovalTicket(BASE_PARAMS);

    const result = verifyApprovalTicket(ticket, "wrong-secret");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("throws when AGENT_ACCESS_TICKET_SECRET is not set", () => {
    delete process.env.AGENT_ACCESS_TICKET_SECRET;
    expect(() => generateApprovalTicket(BASE_PARAMS)).toThrow(/AGENT_ACCESS_TICKET_SECRET/);
  });
});
