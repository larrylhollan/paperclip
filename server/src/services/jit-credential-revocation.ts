import type { Db } from "@paperclipai/db";
import { jitPreApprovalService } from "./jit-pre-approvals.js";
import { revokeIssuancesForIssue, type RevokedIssuance } from "../jit-issuance-store.js";
import { fetchWithRetry } from "../jit-fetch-retry.js";
import { logger } from "../middleware/logger.js";

/**
 * Notify rex-agent to revoke exec token JTIs so they are rejected immediately
 * rather than waiting for expiry.
 */
async function revokeExecTokensOnRexAgent(revoked: RevokedIssuance[]): Promise<void> {
  const secret = process.env.REX_JWT_SECRET;
  const rexBaseUrl = process.env.REX_AGENT_BASE_URL; // e.g. "https://work.int.hollan.dev/rex/api"
  if (!secret || !rexBaseUrl) return;

  // Build a short-lived admin JWT for the revocation call itself.
  const { createHmac, randomUUID } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const adminClaims = {
    iss: "paperclip",
    sub: "system:revocation",
    aud: "rex-agent",
    iat: now,
    exp: now + 60, // 1 minute
    jti: randomUUID(),
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(adminClaims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const adminToken = `${header}.${payload}.${signature}`;

  for (const entry of revoked) {
    const p = entry.payload;
    if (p.type !== "exec_token" || typeof p.jti !== "string" || typeof p.exp !== "number") continue;

    try {
      await fetchWithRetry(`${rexBaseUrl}/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ jti: p.jti, exp: p.exp }),
      }, { label: "rex-revoke", retries: 2 });
    } catch (err) {
      logger.warn({ err, jti: p.jti, issueId: entry.id }, "failed to revoke exec token on rex-agent");
    }
  }
}

export async function revokeCredentialsOnIssueClose(
  db: Db,
  issueId: string,
  newStatus: string,
): Promise<{ preApprovalsRevoked: number; issuancesRevoked: number }> {
  const svc = jitPreApprovalService(db);

  const [preApprovalResult, issuanceResult] = await Promise.all([
    svc.revokeForIssue(issueId),
    revokeIssuancesForIssue(issueId),
  ]);

  const total = preApprovalResult.revokedCount + issuanceResult.count;
  if (total > 0) {
    logger.info(
      {
        issueId,
        newStatus,
        preApprovalsRevoked: preApprovalResult.revokedCount,
        issuancesRevoked: issuanceResult.count,
      },
      "revoked JIT credentials on issue close",
    );
  }

  // Fire-and-forget: notify rex-agent about revoked exec tokens.
  if (issuanceResult.revoked.length > 0) {
    void revokeExecTokensOnRexAgent(issuanceResult.revoked).catch((err) =>
      logger.warn({ err, issueId }, "failed to revoke exec tokens on rex-agent"));
  }

  return {
    preApprovalsRevoked: preApprovalResult.revokedCount,
    issuancesRevoked: issuanceResult.count,
  };
}
