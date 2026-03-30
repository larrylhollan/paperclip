import type { Db } from "@paperclipai/db";
import { jitPreApprovalService } from "./jit-pre-approvals.js";
import { revokeIssuancesForIssue } from "../jit-issuance-store.js";
import { logger } from "../middleware/logger.js";

export async function revokeCredentialsOnIssueClose(
  db: Db,
  issueId: string,
  newStatus: string,
): Promise<{ preApprovalsRevoked: number; issuancesRevoked: number }> {
  const svc = jitPreApprovalService(db);

  const [preApprovalResult, issuancesRevoked] = await Promise.all([
    svc.revokeForIssue(issueId),
    revokeIssuancesForIssue(issueId),
  ]);

  const total = preApprovalResult.revokedCount + issuancesRevoked;
  if (total > 0) {
    logger.info(
      {
        issueId,
        newStatus,
        preApprovalsRevoked: preApprovalResult.revokedCount,
        issuancesRevoked,
      },
      "revoked JIT credentials on issue close",
    );
  }

  return {
    preApprovalsRevoked: preApprovalResult.revokedCount,
    issuancesRevoked,
  };
}
