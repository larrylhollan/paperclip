import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { jitPreApprovals } from "@paperclipai/db";
import { eq, and, ne } from "drizzle-orm";
import { jitPreApprovalService } from "../services/jit-pre-approvals.js";
import {
  getJitApprovalBotToken,
  getAllowedUserIds,
  editMessageReplyMarkupWithBot,
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

    // Parse callback_data: "jit:approve:<id>" or "jit:reject:<id>"
    const data = cbq.data ?? "";
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

      // Best-effort: rebuild keyboard with remaining pending siblings
      if (cbq.message) {
        const chatId = String(cbq.message.chat.id);
        const messageId = cbq.message.message_id;

        try {
          const siblings = await db
            .select({
              id: jitPreApprovals.id,
              target: jitPreApprovals.target,
            })
            .from(jitPreApprovals)
            .where(
              and(
                eq(jitPreApprovals.telegramMessageId, messageId),
                eq(jitPreApprovals.telegramChatId, chatId),
                ne(jitPreApprovals.id, preApprovalId),
                eq(jitPreApprovals.status, "pending"),
              ),
            );

          const remainingKeyboard = siblings.map((sib) => [
            { text: `✅ Approve ${sib.target}`, callback_data: `jit:approve:${sib.id}` },
            { text: `❌ Reject ${sib.target}`, callback_data: `jit:reject:${sib.id}` },
          ]);

          await editMessageReplyMarkupWithBot(chatId, messageId, remainingKeyboard);
        } catch (editErr) {
          logger.debug({ err: editErr, preApprovalId }, "Could not edit message after callback action");
        }
      }
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
