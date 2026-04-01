import { createHmac } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { issues, jitPreApprovals } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JitPreApprovalRecord {
  id: string;
  issueId: string;
  target: string;
  role: string;
  reason: string;
  status: string;
}

export interface IssueInfo {
  id: string;
  identifier: string;
  title: string;
  parentId: string | null;
}

interface ParentIssueInfo {
  identifier: string;
  title: string;
}

interface QueueEntry {
  records: JitPreApprovalRecord[];
  issue: IssueInfo;
}

// ---------------------------------------------------------------------------
// Config (from env)
// ---------------------------------------------------------------------------

function getConfig() {
  const botToken = process.env.JIT_TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.JIT_TELEGRAM_CHAT_ID ?? "";
  const threadId = process.env.JIT_TELEGRAM_THREAD_ID ?? undefined;
  const hmacSecret =
    process.env.JIT_APPROVAL_HMAC_SECRET ??
    process.env.BETTER_AUTH_SECRET ??
    "";
  const publicUrl = (
    process.env.JIT_APPROVAL_PUBLIC_URL ?? "http://127.0.0.1:3100"
  ).replace(/\/$/, "");

  return { botToken, chatId, threadId, hmacSecret, publicUrl };
}

// ---------------------------------------------------------------------------
// HMAC helpers (exported for route verification)
// ---------------------------------------------------------------------------

export function signAction(preApprovalId: string, action: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${preApprovalId}:${action}`)
    .digest("hex");
}

export function verifyAction(
  preApprovalId: string,
  action: string,
  sig: string,
  secret: string,
): boolean {
  const expected = signAction(preApprovalId, action, secret);
  // Constant-time compare
  if (expected.length !== sig.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return result === 0;
}

export function getHmacSecret(): string {
  return getConfig().hmacSecret;
}

// ---------------------------------------------------------------------------
// DB-persisted Telegram message-id tracking
// ---------------------------------------------------------------------------

interface InlineButton {
  text: string;
  url: string;
}

async function saveTelegramMessageId(
  db: Db,
  preApprovalId: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  await db
    .update(jitPreApprovals)
    .set({ telegramMessageId: messageId, telegramChatId: chatId })
    .where(eq(jitPreApprovals.id, preApprovalId));
}

// ---------------------------------------------------------------------------
// Telegram send helpers
// ---------------------------------------------------------------------------

async function telegramPost(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const { botToken } = getConfig();
  if (!botToken) return null;
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await resp.json()) as Record<string, unknown>;
    if (!data.ok) {
      logger.warn({ method, error: data }, "Telegram API error");
      return null;
    }
    return data;
  } catch (err) {
    logger.warn({ err, method }, "Telegram API request failed");
    return null;
  }
}

async function sendMessage(
  text: string,
  replyMarkup?: unknown,
): Promise<number | null> {
  const { chatId, threadId } = getConfig();
  if (!chatId) return null;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (threadId) body.message_thread_id = Number(threadId);
  if (replyMarkup) body.reply_markup = replyMarkup;
  const result = await telegramPost("sendMessage", body);
  if (!result) return null;
  const msg = result.result as Record<string, unknown> | undefined;
  return (msg?.message_id as number) ?? null;
}

export async function editMessageText(
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  await telegramPost("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  });
}

export async function editMessageReplyMarkup(
  chatId: string,
  messageId: number,
  keyboard: InlineButton[][] = [],
): Promise<void> {
  await telegramPost("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
}

// ---------------------------------------------------------------------------
// Notification message builders
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildActionUrl(preApprovalId: string, action: "approved" | "rejected"): string {
  const { publicUrl, hmacSecret } = getConfig();
  const sig = signAction(preApprovalId, action, hmacSecret);
  return `${publicUrl}/api/jit-pre-approvals/${preApprovalId}/quick-action?action=${action}&sig=${sig}`;
}

function buildSingleIssueMessage(
  issue: IssueInfo,
  records: JitPreApprovalRecord[],
): { text: string; keyboard: InlineButton[][]; replyMarkup: unknown } {
  const lines = [`🔑 <b>JIT Pre-Approval Request</b>`];
  lines.push(`<b>${escapeHtml(issue.identifier)}</b>: ${escapeHtml(issue.title)}`);
  for (const r of records) {
    lines.push(`  → ${escapeHtml(r.target)} (${escapeHtml(r.role)}): ${escapeHtml(r.reason)}`);
  }
  const text = lines.join("\n");

  // One row of approve/reject buttons per pre-approval record
  const keyboard: InlineButton[][] = records.map((r) => [
    { text: `✅ Approve ${r.target}`, url: buildActionUrl(r.id, "approved") },
    { text: `❌ Reject ${r.target}`, url: buildActionUrl(r.id, "rejected") },
  ]);

  return { text, keyboard, replyMarkup: { inline_keyboard: keyboard } };
}

function buildGroupedMessage(
  parentInfo: ParentIssueInfo,
  entries: QueueEntry[],
): { text: string; keyboard: InlineButton[][]; replyMarkup: unknown } {
  const lines = [
    `🔑 <b>JIT Pre-Approvals — ${escapeHtml(parentInfo.title)} (${entries.length} issues)</b>`,
  ];
  for (const entry of entries) {
    const targets = entry.records.map((r) => `${r.target} (${r.role})`).join(", ");
    lines.push(`  <b>${escapeHtml(entry.issue.identifier)}</b>: ${escapeHtml(entry.issue.title)} → ${escapeHtml(targets)}`);
  }
  const text = lines.join("\n");

  // Per-issue approve/reject buttons (each record gets its own row)
  const keyboard: InlineButton[][] = [];
  for (const entry of entries) {
    for (const r of entry.records) {
      keyboard.push([
        { text: `✅ ${entry.issue.identifier} ${r.target}`, url: buildActionUrl(r.id, "approved") },
        { text: `❌ ${entry.issue.identifier} ${r.target}`, url: buildActionUrl(r.id, "rejected") },
      ]);
    }
  }

  return { text, keyboard, replyMarkup: { inline_keyboard: keyboard } };
}

// ---------------------------------------------------------------------------
// Grouping queue (debounce by parentId)
// ---------------------------------------------------------------------------

const groupingQueue = new Map<string, { entries: QueueEntry[]; timer: ReturnType<typeof setTimeout> }>();

const GROUP_WINDOW_MS = 30_000;

function flushGroup(parentId: string, db: Db) {
  const group = groupingQueue.get(parentId);
  if (!group) return;
  groupingQueue.delete(parentId);

  void (async () => {
    try {
      if (group.entries.length === 1) {
        // Single issue — send individual message
        const entry = group.entries[0];
        const single = buildSingleIssueMessage(entry.issue, entry.records);
        const messageId = await sendMessage(single.text, single.replyMarkup);
        if (messageId) {
          for (const r of entry.records) {
            void saveTelegramMessageId(db, r.id, getConfig().chatId, messageId).catch((err) =>
              logger.debug({ err, preApprovalId: r.id }, "Failed to persist Telegram message ID"),
            );
          }
        }
      } else {
        // Multiple issues — try to fetch parent info for grouped message
        let parentInfo: ParentIssueInfo = {
          identifier: "Parent",
          title: "Multiple Issues",
        };
        try {
          const parentRows = await db
            .select({ identifier: issues.identifier, title: issues.title })
            .from(issues)
            .where(eq(issues.id, parentId));
          const parentIssue = parentRows[0] ?? null;
          if (parentIssue) {
            parentInfo = {
              identifier: parentIssue.identifier ?? "Parent",
              title: parentIssue.title,
            };
          }
        } catch (err) {
          logger.debug({ err, parentId }, "Could not fetch parent issue for grouping");
        }

        const grouped = buildGroupedMessage(parentInfo, group.entries);
        const messageId = await sendMessage(grouped.text, grouped.replyMarkup);
        if (messageId) {
          for (const entry of group.entries) {
            for (const r of entry.records) {
              void saveTelegramMessageId(db, r.id, getConfig().chatId, messageId).catch((err) =>
                logger.debug({ err, preApprovalId: r.id }, "Failed to persist Telegram message ID"),
              );
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err, parentId }, "Failed to send JIT pre-approval notification");
    }
  })();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Queue a JIT pre-approval notification. Groups by parentId with a 30s window.
 * If parentId is null, sends immediately (no grouping).
 */
export function queueJitNotification(
  db: Db,
  issue: IssueInfo,
  records: JitPreApprovalRecord[],
): void {
  const { botToken, chatId } = getConfig();
  if (!botToken || !chatId) {
    logger.debug("JIT notification skipped: JIT_TELEGRAM_BOT_TOKEN or JIT_TELEGRAM_CHAT_ID not set");
    return;
  }

  if (records.length === 0) return;

  const parentId = issue.parentId;

  if (!parentId) {
    // No parent — send immediately, no grouping
    void (async () => {
      try {
        const msg = buildSingleIssueMessage(issue, records);
        const messageId = await sendMessage(msg.text, msg.replyMarkup);
        if (messageId) {
          for (const r of records) {
            void saveTelegramMessageId(db, r.id, chatId, messageId).catch((err) =>
              logger.debug({ err, preApprovalId: r.id }, "Failed to persist Telegram message ID"),
            );
          }
        }
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "Failed to send JIT pre-approval notification");
      }
    })();
    return;
  }

  // Group by parentId
  const existing = groupingQueue.get(parentId);
  if (existing) {
    existing.entries.push({ records, issue });
  } else {
    const timer = setTimeout(() => flushGroup(parentId, db), GROUP_WINDOW_MS);
    groupingQueue.set(parentId, { entries: [{ records, issue }], timer });
  }
}

/**
 * Send a renewal notification (simple text, no buttons).
 */
export async function sendRenewalNotification(
  issueIdentifier: string,
  target: string,
  role: string,
  renewalCount: number,
): Promise<void> {
  const { botToken, chatId } = getConfig();
  if (!botToken || !chatId) return;
  const text =
    `🔄 <b>${escapeHtml(issueIdentifier)}</b> renewed its credential ` +
    `(${escapeHtml(target)}, ${escapeHtml(role)}) for another 2 hours ` +
    `(${renewalCount}/1 renewal used)`;
  try {
    await sendMessage(text);
  } catch (err) {
    logger.warn({ err, issueIdentifier }, "Failed to send renewal notification");
  }
}

/**
 * Edit a previously sent Telegram message after a quick-action approve/reject.
 * Removes inline keyboard to signal the action was handled.
 * Best-effort — failures are logged but never thrown.
 */
export async function editAfterQuickAction(
  db: Db,
  preApprovalId: string,
  _action: "approved" | "rejected",
  _target: string,
  _role: string,
  _issueIdentifier: string,
): Promise<void> {
  const rows = await db
    .select({
      telegramMessageId: jitPreApprovals.telegramMessageId,
      telegramChatId: jitPreApprovals.telegramChatId,
    })
    .from(jitPreApprovals)
    .where(eq(jitPreApprovals.id, preApprovalId));
  const stored = rows[0];
  if (!stored?.telegramMessageId || !stored?.telegramChatId) return;

  try {
    await editMessageReplyMarkup(stored.telegramChatId, stored.telegramMessageId, []);
  } catch (err) {
    logger.warn({ err, preApprovalId }, "Failed to edit Telegram message after JIT action");
  }
}
