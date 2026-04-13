import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { jitPreApprovalService } from "../services/jit-pre-approvals.js";
import { approvalService, heartbeatService } from "../services/index.js";
import {
  getJitApprovalBotToken,
  getAllowedUserIds,
} from "../services/jit-notification.js";
import { logger } from "../middleware/logger.js";

interface TelegramUser {
  id: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  callback_query?: TelegramCallbackQuery;
}

async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  const botToken = getJitApprovalBotToken();
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to answer callback query");
  }
}

/**
 * Telegram webhook route for the dedicated JIT approval bot.
 * Handles callback_data button presses with Telegram-verified identity.
 * Mounted BEFORE auth middleware — Telegram verifies the user, not sessions.
 */
export function jitTelegramWebhookRoutes(db: Db) {
  const router = Router();
  const svc = jitPreApprovalService(db);
  const approvalsSvc = approvalService(db);
  const heartbeat = heartbeatService(db);

  router.post("/telegram/jit-webhook", async (req, res) => {
    const update = req.body as TelegramUpdate;

    if (!update.callback_query) {
      res.status(200).json({ ok: true });
      return;
    }

    const cbq = update.callback_query;
    const telegramUserId = String(cbq.from.id);

    // Verify the pressing user is in the allowed list
    if (!getAllowedUserIds().has(telegramUserId)) {
      await answerCallbackQuery(cbq.id, "⛔ Not authorized");
      res.status(200).json({ ok: true });
      return;
    }

    const data = cbq.data ?? "";

    // ── Exec token approval callbacks ──────────────────────────────
    const execMatch = data.match(/^jit:(approve-exec|reject-exec):(.+)$/);
    if (execMatch) {
      const action = execMatch[1] === "approve-exec" ? "approve" : "reject";
      const execApprovalId = execMatch[2];

      try {
        const decisionNote = `Telegram callback by user ${telegramUserId}`;
        if (action === "approve") {
          await approvalsSvc.approve(execApprovalId, `telegram:${telegramUserId}`, decisionNote);
        } else {
          await approvalsSvc.reject(execApprovalId, `telegram:${telegramUserId}`, decisionNote);
        }

        const emoji = action === "approve" ? "✅" : "❌";
        const verb = action === "approve" ? "Approved" : "Rejected";
        await answerCallbackQuery(cbq.id, `${emoji} Exec token ${verb}!`);

        // Wake the requesting agent so it retries with the approvalId.
        if (action === "approve") {
          try {
            const execApproval = await approvalsSvc.getById(execApprovalId);
            const payload = execApproval?.payload as Record<string, unknown> | undefined;
            const assigneeAgentId = typeof payload?.assigneeAgentId === "string" ? payload.assigneeAgentId : null;
            const agentToWake = typeof payload?.requestedByAgentId === "string"
              ? payload.requestedByAgentId
              : (assigneeAgentId ?? (typeof execApproval?.requestedByAgentId === "string" ? execApproval.requestedByAgentId : null));
            const issueId = typeof payload?.issueId === "string" ? payload.issueId : undefined;
            if (agentToWake) {
              void heartbeat.wakeup(agentToWake, {
                source: "automation",
                triggerDetail: "system",
                reason: "jit_exec_token_approved",
                payload: { approvalId: execApprovalId, issueId, target: payload?.target },
                contextSnapshot: issueId
                  ? { issueId, taskId: issueId, source: "jit_exec_token_approved", wakeReason: "jit_exec_token_approved" }
                  : undefined,
              }).catch((err) => logger.warn({ err, approvalId: execApprovalId }, "failed to wake agent after exec token approval"));
            }
          } catch (err) {
            logger.warn({ err, approvalId: execApprovalId }, "failed to look up approval for agent wake");
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("pending") || errMsg.includes("already")) {
          await answerCallbackQuery(cbq.id, "ℹ️ Already processed");
        } else if (errMsg.includes("not found")) {
          await answerCallbackQuery(cbq.id, "❓ Not found");
        } else {
          logger.error({ err, approvalId: execApprovalId, action }, "JIT exec token webhook callback failed");
          await answerCallbackQuery(cbq.id, "❌ Error processing action");
        }
      }

      res.status(200).json({ ok: true });
      return;
    }

    // ── SSH pre-approval callbacks ─────────────────────────────────
    // Parse callback_data: "jit:approve:<id>" or "jit:reject:<id>"
    const match = data.match(/^jit:(approve|reject):(.+)$/);
    if (!match) {
      await answerCallbackQuery(cbq.id, "Unknown action");
      res.status(200).json({ ok: true });
      return;
    }

    const action = match[1] as "approve" | "reject";
    const preApprovalId = match[2];
    const status = action === "approve" ? "approved" : "rejected";

    try {
      await svc.updateStatus(preApprovalId, status, `telegram:${telegramUserId}`);

      const emoji = status === "approved" ? "✅" : "❌";
      const verb = status === "approved" ? "Approved" : "Rejected";
      await answerCallbackQuery(cbq.id, `${emoji} ${verb}!`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Only pending")) {
        await answerCallbackQuery(cbq.id, "ℹ️ Already processed");
      } else if (errMsg.includes("not found")) {
        await answerCallbackQuery(cbq.id, "❓ Not found");
      } else {
        logger.error({ err, preApprovalId, action }, "JIT webhook callback failed");
        await answerCallbackQuery(cbq.id, "❌ Error processing action");
      }
    }

    res.status(200).json({ ok: true });
  });

  return router;
}
