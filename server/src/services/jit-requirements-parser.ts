import type { Db } from "@paperclipai/db";
import { jitPreApprovalService } from "./jit-pre-approvals.js";
import { issueService } from "./issues.js";
import { queueJitNotification, type IssueInfo, type JitPreApprovalRecord } from "./jit-notification.js";
import { logger } from "../middleware/logger.js";

/**
 * Parse the `## JIT Requirements` section from a markdown issue description.
 *
 * Expected format:
 * ```markdown
 * ## JIT Requirements
 * - target: work.int | role: agent-admin | reason: Deploy ticket verifier
 * - target: pc.int | role: agent-admin | reason: Run integration tests
 * ```
 *
 * Returns an array of { target, role, reason } objects.
 * Returns empty array if no JIT Requirements section found.
 */
export function parseJitRequirements(
  description: string | null | undefined,
): Array<{ target: string; role: string; reason: string }> {
  if (!description) return [];

  // Find the ## JIT Requirements heading (case-insensitive)
  const headingPattern = /^##\s+jit\s+requirements\s*$/im;
  const match = headingPattern.exec(description);
  if (!match) return [];

  // Extract content between this heading and the next ## heading (or end of string)
  const afterHeading = description.slice(match.index + match[0].length);
  const nextHeadingMatch = /^##\s/m.exec(afterHeading);
  const section = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;

  const results: Array<{ target: string; role: string; reason: string }> = [];
  const linePattern =
    /^[-*]\s*target:\s*(.+?)\s*\|\s*role:\s*(.+?)\s*\|\s*reason:\s*(.+)$/i;

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lineMatch = linePattern.exec(trimmed);
    if (!lineMatch) continue;

    const target = lineMatch[1].trim();
    const role = lineMatch[2].trim();
    const reason = lineMatch[3].trim();

    if (target && role && reason) {
      results.push({ target, role, reason });
    }
  }

  return results;
}

/**
 * Sync JIT pre-approval records from a parsed description.
 *
 * On issue create: create pre-approval records for all parsed requirements.
 * On issue update: diff existing records against parsed requirements and
 *   create new records for requirements not yet tracked.
 *   Does NOT delete existing records (they may already be approved/exchanged).
 *
 * Idempotency: skip creating records where an existing record with same
 * issueId + target + role already exists (regardless of status).
 *
 * After creating new records, queues a Telegram notification (fire-and-forget).
 */
export async function syncJitPreApprovals(
  db: Db,
  issueId: string,
  description: string | null | undefined,
): Promise<void> {
  const parsed = parseJitRequirements(description);
  if (parsed.length === 0) return;

  const svc = jitPreApprovalService(db);
  const existing = await svc.listForIssue(issueId);

  const existingKeys = new Set(
    existing.map((r) => `${r.target}::${r.role}`),
  );

  const newRecords = parsed.filter(
    (r) => !existingKeys.has(`${r.target}::${r.role}`),
  );

  if (newRecords.length === 0) return;

  const created = await svc.createForIssue(issueId, newRecords);
  logger.info(
    { issueId, count: newRecords.length },
    "synced JIT pre-approval records from issue description",
  );

  // Fire-and-forget: send Telegram notification for the new records
  try {
    const issueSvc = issueService(db);
    const issue = await issueSvc.getById(issueId);
    if (issue) {
      const issueInfo: IssueInfo = {
        id: issue.id,
        identifier: issue.identifier ?? issueId,
        title: issue.title,
        parentId: issue.parentId,
      };
      const notifyRecords: JitPreApprovalRecord[] = created.map((r) => ({
        id: r.id,
        issueId: r.issueId,
        target: r.target,
        role: r.role,
        reason: r.reason,
        status: r.status,
      }));
      queueJitNotification(db, issueInfo, notifyRecords);
    }
  } catch (err) {
    logger.warn({ err, issueId }, "Failed to queue JIT notification after sync");
  }
}
