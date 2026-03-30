import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { jitPreApprovals } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

export function jitPreApprovalService(db: Db) {
  return {
    async createForIssue(
      issueId: string,
      records: Array<{ target: string; role: string; reason: string }>,
    ) {
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const values = records.map((r) => ({
        issueId,
        target: r.target,
        role: r.role,
        reason: r.reason,
        expiresAt,
      }));
      return db.insert(jitPreApprovals).values(values).returning();
    },

    async listForIssue(issueId: string, status?: string) {
      const conditions = [eq(jitPreApprovals.issueId, issueId)];
      if (status) {
        conditions.push(eq(jitPreApprovals.status, status as typeof jitPreApprovals.status.enumValues[number]));
      }
      return db.select().from(jitPreApprovals).where(and(...conditions));
    },

    async getById(id: string) {
      return db
        .select()
        .from(jitPreApprovals)
        .where(eq(jitPreApprovals.id, id))
        .then((rows) => rows[0] ?? null);
    },

    async updateStatus(id: string, status: "approved" | "rejected", approvedByUserId: string) {
      const existing = await db
        .select()
        .from(jitPreApprovals)
        .where(eq(jitPreApprovals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Pre-approval not found");
      if (existing.status !== "pending") {
        throw unprocessable("Only pending pre-approvals can be approved or rejected");
      }

      const now = new Date();
      return db
        .update(jitPreApprovals)
        .set({
          status,
          approvedByUserId,
          approvedAt: now,
        })
        .where(eq(jitPreApprovals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    async exchange(id: string, runId: string) {
      const existing = await db
        .select()
        .from(jitPreApprovals)
        .where(eq(jitPreApprovals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Pre-approval not found");
      if (existing.status !== "approved") {
        throw unprocessable("Only approved pre-approvals can be exchanged");
      }
      if (existing.expiresAt <= new Date()) {
        throw unprocessable("Pre-approval has expired");
      }

      const now = new Date();
      const credentialExpiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      return db
        .update(jitPreApprovals)
        .set({
          status: "exchanged",
          exchangedAt: now,
          exchangedByRunId: runId,
          credentialExpiresAt,
        })
        .where(eq(jitPreApprovals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    async renew(id: string) {
      const existing = await db
        .select()
        .from(jitPreApprovals)
        .where(eq(jitPreApprovals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Pre-approval not found");
      if (existing.status !== "exchanged") {
        throw unprocessable("Only exchanged pre-approvals can be renewed");
      }
      if (existing.renewalCount >= 1) {
        throw unprocessable("Pre-approval has already been renewed");
      }

      const now = new Date();
      const credentialExpiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      return db
        .update(jitPreApprovals)
        .set({
          renewalCount: existing.renewalCount + 1,
          credentialExpiresAt,
        })
        .where(eq(jitPreApprovals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    async expireStale() {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      // Expire pending/approved records older than 7 days
      const expiredApprovals = await db
        .update(jitPreApprovals)
        .set({ status: "expired" })
        .where(
          and(
            sql`${jitPreApprovals.status} IN ('pending', 'approved')`,
            lt(jitPreApprovals.createdAt, sevenDaysAgo),
          ),
        )
        .returning();

      // Expire exchanged records with expired credentials
      const expiredCredentials = await db
        .update(jitPreApprovals)
        .set({ status: "expired" })
        .where(
          and(
            eq(jitPreApprovals.status, "exchanged"),
            lt(jitPreApprovals.credentialExpiresAt, now),
          ),
        )
        .returning();

      return {
        expiredApprovals: expiredApprovals.length,
        expiredCredentials: expiredCredentials.length,
      };
    },
  };
}
