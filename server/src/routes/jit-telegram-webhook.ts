import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { jitPreApprovalService } from "../services/jit-pre-approvals.js";
import { approvalService, heartbeatService, agentService, issueService } from "../services/index.js";
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
  const agentsSvc = agentService(db);
  const issuesSvc = issueService(db);

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
            // Ad-hoc exec token requests store the agent as payload.agentId (not requestedByAgentId)
            const payloadAgentId = typeof payload?.agentId === "string" ? payload.agentId : null;
            const agentToWake = typeof payload?.requestedByAgentId === "string"
              ? payload.requestedByAgentId
              : (assigneeAgentId ?? (typeof execApproval?.requestedByAgentId === "string" ? execApproval.requestedByAgentId : null) ?? payloadAgentId);
            const issueId = typeof payload?.issueId === "string" ? payload.issueId : undefined;
            const originSessionKey = typeof payload?.originSessionKey === "string" ? payload.originSessionKey : null;
            const originGatewayPort = typeof payload?.originGatewayPort === "number" ? payload.originGatewayPort : null;

            // Post comment + unblock issue so Paperclip adapter picks it up
            if (issueId) {
              try {
                const issue = await issuesSvc.getById(issueId);
                const commentBody = `JIT exec token approved by telegram:${telegramUserId} for ${payload?.target ?? "unknown"}. Agent can now proceed.`;
                await issuesSvc.addComment(issueId, commentBody, {});
                if (issue?.status === "blocked") {
                  await issuesSvc.update(issueId, { status: "todo" });
                }
              } catch (err) {
                logger.warn({ err, approvalId: execApprovalId }, "failed to unblock issue after exec token approval");
              }
            }

            if (!agentToWake) {
              logger.warn({ approvalId: execApprovalId, payload: payload ? Object.keys(payload) : [] }, "exec token approved but agentToWake resolved to null — no agent to wake");
            }

            if (agentToWake) {
              // Try session-targeted wake via gateway API if origin session info is available
              let sessionWakeSent = false;
              if (originSessionKey && originGatewayPort) {
                try {
                  const agent = await agentsSvc.getById(agentToWake);
                  const adapterConfig = agent?.adapterConfig as Record<string, unknown> | undefined;
                  // authToken is a top-level field in adapterConfig for openclaw_gateway agents
                  const gatewayToken = typeof adapterConfig?.authToken === "string" ? adapterConfig.authToken : null;

                  if (gatewayToken && agent?.urlKey) {
                    const wakeUrl = `http://127.0.0.1:${originGatewayPort}/v1/chat/completions`;
                    const wakeBody = JSON.stringify({
                      model: `openclaw/${agent.urlKey}`,
                      messages: [{ role: "user", content: `JIT exec token approved for ${payload?.target ?? "unknown"} (approvalId: ${execApprovalId}). Retry your command.` }],
                      stream: false,
                    });

                    // Fire-and-forget: the gateway processes a full agent turn which
                    // can take 30s+. We don't need to wait for the response — just
                    // confirm the request was accepted and let it complete in the background.
                    sessionWakeSent = true;
                    fetch(wakeUrl, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${gatewayToken}`,
                        "x-openclaw-session-key": originSessionKey,
                      },
                      body: wakeBody,
                      signal: AbortSignal.timeout(120_000),
                    }).then((wakeResp) => {
                      if (!wakeResp.ok) {
                        logger.warn({ status: wakeResp.status, approvalId: execApprovalId }, "session-targeted wake returned non-OK");
                      } else {
                        logger.info({ approvalId: execApprovalId, agentId: agentToWake }, "session-targeted wake completed via gateway");
                      }
                    }).catch((err) => {
                      logger.warn({ err, approvalId: execApprovalId }, "session-targeted wake failed (fire-and-forget)");
                    });
                    logger.info({ approvalId: execApprovalId, agentId: agentToWake }, "session-targeted wake dispatched via gateway (fire-and-forget)");
                  }
                } catch (err) {
                  logger.warn({ err, approvalId: execApprovalId }, "session-targeted wake failed, falling back to heartbeat");
                }
              }

              // Fall back to heartbeat wakeup if session wake wasn't sent
              if (!sessionWakeSent) {
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
      const updatedPreApproval = await svc.updateStatus(preApprovalId, status, `telegram:${telegramUserId}`);

      const emoji = status === "approved" ? "✅" : "❌";
      const verb = status === "approved" ? "Approved" : "Rejected";
      await answerCallbackQuery(cbq.id, `${emoji} ${verb}!`);

      // After SSH pre-approval: post comment + unblock issue + wake agent
      if (status === "approved" && updatedPreApproval?.issueId) {
        try {
          const issue = await issuesSvc.getById(updatedPreApproval.issueId);

          // Post system comment so the adapter sees new activity
          const commentBody = `JIT SSH pre-approval approved by telegram:${telegramUserId} for ${updatedPreApproval.target} (${updatedPreApproval.role}). Agent can now proceed.`;
          await issuesSvc.addComment(updatedPreApproval.issueId, commentBody, {});

          // Transition blocked → todo so Paperclip adapter picks it up for a new run
          if (issue?.status === "blocked") {
            await issuesSvc.update(updatedPreApproval.issueId, { status: "todo" });
          }

          // Wake the assigned agent via heartbeat
          if (issue?.assigneeAgentId) {
            void heartbeat.wakeup(issue.assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "jit_pre_approval_approved",
              payload: { preApprovalId, issueId: updatedPreApproval.issueId, target: updatedPreApproval.target },
              contextSnapshot: {
                issueId: updatedPreApproval.issueId,
                taskId: updatedPreApproval.issueId,
                source: "jit_pre_approval_approved",
                wakeReason: "jit_pre_approval_approved",
              },
            }).catch((err) => logger.warn({ err, preApprovalId }, "failed to wake agent after SSH pre-approval"));
          }
        } catch (err) {
          logger.warn({ err, preApprovalId }, "failed to unblock issue after SSH pre-approval");
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
