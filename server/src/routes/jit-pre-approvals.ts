import { readFileSync } from "node:fs";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createJitPreApprovalSchema,
  updateJitPreApprovalStatusSchema,
  exchangeJitPreApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { jitPreApprovalService } from "../services/jit-pre-approvals.js";
import { issueService } from "../services/issues.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  verifyAction,
  getHmacSecret,
  editAfterQuickAction,
  sendRenewalNotification,
} from "../services/jit-notification.js";
import { logger } from "../middleware/logger.js";
import { getJitTarget } from "../jit-target-registry.js";
import { createIssuanceId, storeIssuance } from "../jit-issuance-store.js";
import { generateApprovalTicket } from "../jit-approval-ticket.js";
import { computeJitApprovalHash } from "../jit-approval-hash.js";

function quickActionHtml(title: string, detail: string, color: string = "#22c55e"): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;padding:40px 20px;background:#fafafa;">
<div style="max-width:400px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
<h2 style="color:${color};margin:0 0 12px;">${title}</h2>
<p style="margin:0 0 8px;color:#333;">${detail}</p>
<p style="color:#999;font-size:14px;margin:0;">You can close this tab.</p>
</div></body></html>`;
}

/**
 * Quick-action route for Telegram URL buttons. Mounted BEFORE auth middleware
 * in app.ts — authentication is handled via HMAC signature, not session.
 */
export function jitQuickActionRoutes(db: Db) {
  const router = Router();
  const svc = jitPreApprovalService(db);
  const issueSvc = issueService(db);

  router.get("/jit-pre-approvals/:id/quick-action", async (req, res) => {
    const id = req.params.id as string;
    const action = req.query.action as string | undefined;
    const sig = req.query.sig as string | undefined;

    if (!action || !sig || !["approved", "rejected"].includes(action)) {
      res.status(400).send(quickActionHtml("❌ Invalid Request", "Missing or invalid parameters.", "#ef4444"));
      return;
    }

    const secret = getHmacSecret();
    if (!secret) {
      res.status(500).send(quickActionHtml("❌ Server Error", "HMAC secret not configured.", "#ef4444"));
      return;
    }

    if (!verifyAction(id, action, sig, secret)) {
      res.status(403).send(quickActionHtml("🚫 Forbidden", "Invalid signature. This link may have expired.", "#ef4444"));
      return;
    }

    try {
      const record = await svc.updateStatus(id, action as "approved" | "rejected", "quick-action-url");

      // Fetch issue info for the confirmation page
      let issueIdentifier = "";
      let issueDetail = "";
      try {
        const issue = await issueSvc.getById(record.issueId);
        if (issue) {
          issueIdentifier = issue.identifier ?? record.issueId.slice(0, 8);
          issueDetail = `${issueIdentifier}: ${record.target} (${record.role})`;
        } else {
          issueDetail = `${record.target} (${record.role})`;
        }
      } catch {
        issueDetail = `${record.target} (${record.role})`;
      }

      // Best-effort: edit the Telegram message to show result and remove buttons
      void editAfterQuickAction(
        db,
        id,
        action as "approved" | "rejected",
        record.target,
        record.role,
        issueIdentifier || record.issueId.slice(0, 8),
      ).catch((err) => logger.debug({ err, id }, "Could not edit Telegram message after quick-action"));

      const emoji = action === "approved" ? "✅" : "❌";
      const verb = action === "approved" ? "Approved" : "Rejected";
      const color = action === "approved" ? "#22c55e" : "#ef4444";
      res.status(200).send(quickActionHtml(`${emoji} ${verb}`, issueDetail, color));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Only pending")) {
        res.status(200).send(quickActionHtml("ℹ️ Already Processed", "This pre-approval was already handled.", "#3b82f6"));
      } else if (errMsg.includes("not found")) {
        res.status(404).send(quickActionHtml("❓ Not Found", "This pre-approval record was not found.", "#f59e0b"));
      } else {
        logger.error({ err, id, action }, "Quick-action failed");
        res.status(500).send(quickActionHtml("❌ Error", "Something went wrong. Please try again.", "#ef4444"));
      }
    }
  });

  return router;
}

// ── SSH credential generation helper ─────────────────────────────────

function readAgentAccessBearerToken(): string | undefined {
  const inlineToken = process.env.AGENT_ACCESS_BEARER_TOKEN?.trim();
  if (inlineToken) return inlineToken;
  const tokenFile = process.env.AGENT_ACCESS_BEARER_TOKEN_FILE?.trim();
  if (!tokenFile) return undefined;
  try {
    return readFileSync(tokenFile, "utf8").trim() || undefined;
  } catch (err) {
    logger.warn({ err, tokenFile }, "failed to read agent-access bearer token file");
    return undefined;
  }
}

type SignerResponse = {
  fetch_url?: string;
  fetchUrl?: string;
  ssh_host?: string;
  sshHost?: string;
  target_host?: string;
  targetHost?: string;
  ssh_user?: string;
  sshUser?: string;
  principal?: string;
  cert_id?: string;
  certId?: string;
  ttl_minutes?: number;
  ttlMinutes?: number;
  issued_at?: string;
  issuedAt?: string;
  expires_at?: string;
  expiresAt?: string;
};

/**
 * Call the SSH CA signer and store the issuance. Returns credential fields
 * to merge into the API response, or null if credential generation fails
 * (caller should still return the DB record).
 */
async function issueCredentialForPreApproval(
  target: string,
  principal: string,
  issueId: string,
  ttlMinutes: number,
  preApprovalMeta?: { id: string; approvedByUserId: string | null; approvedAt: Date | null },
): Promise<Record<string, unknown> | null> {
  const entry = getJitTarget(target);
  if (!entry) {
    logger.warn({ target }, "pre-approval exchange: target not in JIT registry");
    return null;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const bearerToken = readAgentAccessBearerToken();
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  // Generate approval ticket if secret is configured (matches hardened agent-access requirement)
  let approvalTicket: ReturnType<typeof generateApprovalTicket> | undefined;
  if (process.env.AGENT_ACCESS_TICKET_SECRET && preApprovalMeta?.approvedByUserId && preApprovalMeta?.approvedAt) {
    const paramsHash = computeJitApprovalHash({
      issueId,
      target,
      principal,
      ttlMinutes,
      shareTmux: false,
      assigneeAgentId: "",
    });
    approvalTicket = generateApprovalTicket({
      approvalId: preApprovalMeta.id,
      approvedByUserId: preApprovalMeta.approvedByUserId,
      issueId,
      paramsHash,
      approvedAt: new Date(preApprovalMeta.approvedAt).toISOString(),
    });
  }

  let signRes: Response;
  try {
    signRes = await fetch(`${entry.issuerBaseUrl}/sign-for-issue`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        issueId,
        target,
        principal,
        ttlMinutes,
        ttl_minutes: ttlMinutes,
        ...(approvalTicket ? { approvalTicket } : {}),
      }),
    });
  } catch (err) {
    logger.error({ err, target, issueId }, "pre-approval credential: fetch failed");
    return null;
  }

  if (!signRes.ok) {
    const body = await signRes.text().catch(() => "");
    logger.warn({ target, issueId, status: signRes.status, body }, "pre-approval credential: sign-for-issue failed");
    return null;
  }

  const raw = (await signRes.json()) as SignerResponse;

  const fetchUrl = raw.fetch_url ?? raw.fetchUrl;
  const sshHost = raw.ssh_host ?? raw.sshHost ?? raw.target_host ?? raw.targetHost;
  const sshUser = raw.ssh_user ?? raw.sshUser;
  const certId = raw.cert_id ?? raw.certId;
  const issuedAt = raw.issued_at ?? raw.issuedAt;
  const expiresAt = raw.expires_at ?? raw.expiresAt;
  const resolvedTtl = raw.ttl_minutes ?? raw.ttlMinutes ?? ttlMinutes;

  // Store in issuance store so agents can resolve via fetch_url
  if (fetchUrl) {
    const issuanceId = createIssuanceId();
    const ttlMs = resolvedTtl * 60 * 1000;
    await storeIssuance(
      issuanceId,
      {
        type: "jit-ssh-token",
        target,
        principal: raw.principal ?? principal,
        fetch_url: fetchUrl,
        ssh_host: sshHost,
        ssh_user: sshUser,
        cert_id: certId,
        ttl_minutes: resolvedTtl,
        issued_at: issuedAt,
        expires_at: expiresAt,
      },
      issueId,
      ttlMs,
    );
  }

  // Build credential fields for the response (omit undefined values)
  const creds: Record<string, unknown> = {};
  if (fetchUrl) creds.fetch_url = fetchUrl;
  if (sshHost) creds.ssh_host = sshHost;
  if (sshUser) creds.ssh_user = sshUser;
  if (raw.principal ?? principal) creds.principal = raw.principal ?? principal;
  if (certId) creds.cert_id = certId;
  if (resolvedTtl) creds.ttl_minutes = resolvedTtl;
  if (issuedAt) creds.issued_at = issuedAt;
  if (expiresAt) creds.expires_at = expiresAt;

  return creds;
}

export function jitPreApprovalRoutes(db: Db) {
  const router = Router();
  const svc = jitPreApprovalService(db);
  const issueSvc = issueService(db);

  // Create pre-approval records for an issue
  router.post("/issues/:id/jit-pre-approvals", validate(createJitPreApprovalSchema), async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const records = await svc.createForIssue(issueId, req.body.records);
    res.status(201).json(records);
  });

  // List pre-approvals for an issue
  router.get("/issues/:id/jit-pre-approvals", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const status = req.query.status as string | undefined;
    const records = await svc.listForIssue(issueId, status);
    res.json(records);
  });

  // Approve or reject a pre-approval
  router.patch("/jit-pre-approvals/:id", validate(updateJitPreApprovalStatusSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const record = await svc.updateStatus(id, req.body.status, req.body.approvedByUserId);
    res.json(record);
  });

  // Exchange an approved pre-approval for credential tracking + SSH creds
  router.post("/jit-pre-approvals/:id/exchange", validate(exchangeJitPreApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const record = await svc.exchange(id, req.body.runId);

    // Best-effort credential generation — never block the exchange
    const ttlMinutes = getJitTarget(record.target)?.defaultTtlMinutes ?? 120;
    let creds: Record<string, unknown> | null = null;
    try {
      creds = await issueCredentialForPreApproval(record.target, record.role, record.issueId, ttlMinutes, {
        id: record.id,
        approvedByUserId: record.approvedByUserId,
        approvedAt: record.approvedAt,
      });
    } catch (err) {
      logger.error({ err, id }, "pre-approval exchange: credential generation failed");
    }

    res.json(creds ? { ...record, ...creds } : record);
  });

  // Renew an exchanged pre-approval credential
  router.post("/jit-pre-approvals/:id/renew", async (req, res) => {
    const id = req.params.id as string;
    const record = await svc.renew(id);

    // Fire-and-forget renewal notification
    try {
      const issue = await issueSvc.getById(record.issueId);
      const identifier = issue?.identifier ?? record.issueId;
      void sendRenewalNotification(identifier, record.target, record.role, record.renewalCount);
    } catch (err) {
      logger.debug({ err, id }, "Could not send renewal notification");
    }

    // Best-effort credential generation — never block the renew
    const ttlMinutes = getJitTarget(record.target)?.defaultTtlMinutes ?? 120;
    let creds: Record<string, unknown> | null = null;
    try {
      creds = await issueCredentialForPreApproval(record.target, record.role, record.issueId, ttlMinutes, {
        id: record.id,
        approvedByUserId: record.approvedByUserId,
        approvedAt: record.approvedAt,
      });
    } catch (err) {
      logger.error({ err, id }, "pre-approval renew: credential generation failed");
    }

    res.json(creds ? { ...record, ...creds } : record);
  });

  return router;
}
