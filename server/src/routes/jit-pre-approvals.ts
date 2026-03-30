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
  getSentMessage,
  editMessageText,
  editMessageReplyMarkup,
  sendRenewalNotification,
} from "../services/jit-notification.js";
import { logger } from "../middleware/logger.js";

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

  // Quick-action endpoint for Telegram URL buttons (HMAC-signed, no session auth)
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
      let issueDetail = "";
      try {
        const issue = await issueSvc.getById(record.issueId);
        if (issue) {
          issueDetail = `${issue.identifier}: ${record.target} (${record.role})`;
        } else {
          issueDetail = `${record.target} (${record.role})`;
        }
      } catch {
        issueDetail = `${record.target} (${record.role})`;
      }

      // Best-effort: edit the Telegram message to reflect the action
      const sentMsg = getSentMessage(id);
      if (sentMsg) {
        const emoji = action === "approved" ? "✅" : "❌";
        const verb = action === "approved" ? "Approved" : "Rejected";
        try {
          await editMessageReplyMarkup(sentMsg.chatId, sentMsg.messageId);
        } catch (err) {
          logger.debug({ err, id }, "Could not remove inline keyboard from notification");
        }
      }

      const emoji = action === "approved" ? "✅" : "❌";
      const verb = action === "approved" ? "Approved" : "Rejected";
      const color = action === "approved" ? "#22c55e" : "#ef4444";
      res.status(200).send(quickActionHtml(`${emoji} ${verb}`, issueDetail, color));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Only pending")) {
        // Already acted on
        res.status(200).send(quickActionHtml("ℹ️ Already Processed", `This pre-approval was already handled.`, "#3b82f6"));
      } else if (errMsg.includes("not found")) {
        res.status(404).send(quickActionHtml("❓ Not Found", "This pre-approval record was not found.", "#f59e0b"));
      } else {
        logger.error({ err, id, action }, "Quick-action failed");
        res.status(500).send(quickActionHtml("❌ Error", "Something went wrong. Please try again.", "#ef4444"));
      }
    }
  });

  // Exchange an approved pre-approval for credential tracking
  router.post("/jit-pre-approvals/:id/exchange", validate(exchangeJitPreApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const record = await svc.exchange(id, req.body.runId);
    res.json(record);
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

    res.json(record);
  });

  return router;
}
