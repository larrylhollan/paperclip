import { Router } from "express";
import { createHmac, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { approvals as approvalsTable } from "@paperclipai/db";
import { eq as drizzleEq } from "drizzle-orm";
import {
  approvalService,
  agentService,
} from "../services/index.js";
import { sendExecTokenApprovalNotification } from "../services/jit-notification.js";
import { logger } from "../middleware/logger.js";
import { getActorInfo } from "./authz.js";

const JIT_APPROVAL_TTL_MINUTES = 10;

function signExecJwt(claims: object, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Ad-hoc JIT exec token route — not tied to an issue.
 * Two-phase approval: Phase A creates a pending approval and sends Telegram
 * notification; Phase B (with approvalId) validates and signs the JWT.
 */
export function jitExecTokenRoutes(db: Db) {
  const router = Router();
  const approvalsSvc = approvalService(db);
  const agentsSvc = agentService(db);

  router.post("/jit-exec-token", async (req, res) => {
    const { target, scopes, agentId: requestedAgentId, approvalId } = req.body as {
      target?: string;
      scopes?: string[];
      agentId?: string;
      approvalId?: string;
    };

    // Resolve companyId from actor context
    let companyId: string | null = null;
    if (req.actor.type === "agent") {
      companyId = req.actor.companyId ?? null;
    } else if (req.actor.type === "board") {
      const companyIds = req.actor.companyIds ?? [];
      companyId = companyIds[0] ?? null;
    }
    if (!companyId) {
      res.status(403).json({ error: "Cannot determine company context" });
      return;
    }

    // ── Phase B: Collect token after approval ──────────────────────
    if (approvalId) {
      const approval = await approvalsSvc.getById(approvalId);
      if (!approval) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }

      if (approval.type !== "jit_exec_token_adhoc") {
        res.status(409).json({ error: "Approval is not an ad-hoc exec token approval" });
        return;
      }

      if (approval.status !== "approved") {
        res.status(409).json({ error: `Approval is not approved (current status: ${approval.status})` });
        return;
      }

      const approvalPayload = approval.payload as Record<string, unknown>;
      if (approvalPayload.consumedAt) {
        res.status(409).json({ error: "Approval has already been consumed" });
        return;
      }

      if (approval.decidedAt) {
        const decidedAtMs = new Date(approval.decidedAt).getTime();
        const expiresAtMs = decidedAtMs + JIT_APPROVAL_TTL_MINUTES * 60 * 1000;
        if (Date.now() > expiresAtMs) {
          res.status(409).json({ error: "Approval has expired" });
          return;
        }
      }

      const secret = process.env.REX_JWT_SECRET;
      if (!secret) {
        logger.error("REX_JWT_SECRET not configured — cannot issue exec tokens");
        res.status(500).json({ error: "Exec token signing not configured" });
        return;
      }

      const payloadTarget = approvalPayload.target as string;
      const payloadScopes = approvalPayload.scopes as string[];
      const payloadAgentId = (approvalPayload.agentId as string) ?? "adhoc";
      const now = Math.floor(Date.now() / 1000);
      const ttlSeconds = 2 * 60 * 60;
      const jti = randomUUID();
      const expiresAt = new Date((now + ttlSeconds) * 1000).toISOString();

      const claims = {
        iss: "paperclip",
        sub: `agent:${payloadAgentId}`,
        aud: "rex-agent",
        iat: now,
        exp: now + ttlSeconds,
        jti,
        target: payloadTarget,
        scopes: payloadScopes,
      };

      const token = signExecJwt(claims, secret);

      // Mark approval as consumed
      await db
        .update(approvalsTable)
        .set({ payload: { ...approvalPayload, consumedAt: new Date().toISOString() } })
        .where(drizzleEq(approvalsTable.id, approvalId));

      res.status(201).json({ token, expiresAt });
      return;
    }

    // ── Phase A: Request approval ──────────────────────────────────
    if (!target || typeof target !== "string") {
      res.status(400).json({ error: "Missing required field: target" });
      return;
    }

    const validScopes = scopes && Array.isArray(scopes) ? scopes : ["exec", "exec:script", "exec:stream"];
    const resolvedAgentId = requestedAgentId ?? (req.actor.type === "agent" ? req.actor.agentId : null);

    const actor = getActorInfo(req);
    const approval = await approvalsSvc.create(companyId, {
      type: "jit_exec_token_adhoc",
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
      payload: {
        target,
        scopes: validScopes,
        agentId: resolvedAgentId,
      },
    });

    // Look up agent name for the notification
    let agentName: string | undefined;
    if (resolvedAgentId) {
      const agent = await agentsSvc.getById(resolvedAgentId);
      agentName = agent?.name ?? undefined;
    }

    // Await notification delivery so we can surface failures to the caller.
    // The agent polling loop depends on Jeff seeing this notification.
    const notifResult = await sendExecTokenApprovalNotification({
      approvalId: approval.id,
      target,
      scopes: validScopes,
      agentName,
      agentId: resolvedAgentId ?? undefined,
      adhoc: true,
    });

    res.status(202).json({
      status: "pending_approval",
      approvalId: approval.id,
      notificationDelivered: notifResult.sent,
      ...(notifResult.sent ? {} : { notificationError: notifResult.reason }),
    });
  });

  return router;
}
