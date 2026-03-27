import { createHmac, randomBytes } from "node:crypto";

export interface TicketParams {
  approvalId: string;
  approvedByUserId: string;
  issueId: string;
  paramsHash: string;
  approvedAt: string;
}

export interface ApprovalTicket {
  approvalId: string;
  approvedByUserId: string;
  issueId: string;
  paramsHash: string;
  approvedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

const TICKET_TTL_MINUTES = 10;

function computeCanonicalPayload(ticket: Omit<ApprovalTicket, "signature">): string {
  return JSON.stringify([
    ticket.approvalId,
    ticket.approvedByUserId,
    ticket.issueId,
    ticket.paramsHash,
    ticket.approvedAt,
    ticket.expiresAt,
    ticket.nonce,
  ]);
}

function signPayload(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export function generateApprovalTicket(params: TicketParams): ApprovalTicket {
  const secret = process.env.AGENT_ACCESS_TICKET_SECRET;
  if (!secret) {
    throw new Error("AGENT_ACCESS_TICKET_SECRET is not set");
  }

  const approvedAtDate = new Date(params.approvedAt);
  const expiresAt = new Date(approvedAtDate.getTime() + TICKET_TTL_MINUTES * 60 * 1000).toISOString();
  const nonce = randomBytes(16).toString("hex");

  const ticketWithoutSig = {
    approvalId: params.approvalId,
    approvedByUserId: params.approvedByUserId,
    issueId: params.issueId,
    paramsHash: params.paramsHash,
    approvedAt: params.approvedAt,
    expiresAt,
    nonce,
  };

  const canonical = computeCanonicalPayload(ticketWithoutSig);
  const signature = signPayload(canonical, secret);

  return { ...ticketWithoutSig, signature };
}

export function verifyApprovalTicket(ticket: ApprovalTicket, secret: string): VerificationResult {
  // Verify signature
  const { signature, ...rest } = ticket;
  const canonical = computeCanonicalPayload(rest);
  const expected = signPayload(canonical, secret);

  if (signature !== expected) {
    return { valid: false, error: "Invalid signature" };
  }

  // Verify expiry
  if (new Date(ticket.expiresAt).getTime() < Date.now()) {
    return { valid: false, error: "Ticket has expired" };
  }

  return { valid: true };
}
