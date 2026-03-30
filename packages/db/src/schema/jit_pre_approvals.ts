import { pgTable, uuid, text, timestamp, integer, index, pgEnum } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const jitPreApprovalStatusEnum = pgEnum("jit_pre_approval_status", [
  "pending", "approved", "rejected", "expired", "exchanged"
]);

export const jitPreApprovals = pgTable(
  "jit_pre_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    target: text("target").notNull(),
    role: text("role").notNull(),
    reason: text("reason").notNull(),
    status: jitPreApprovalStatusEnum("status").notNull().default("pending"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    exchangedAt: timestamp("exchanged_at", { withTimezone: true }),
    exchangedByRunId: uuid("exchanged_by_run_id"),
    renewalCount: integer("renewal_count").notNull().default(0),
    credentialExpiresAt: timestamp("credential_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdIdx: index("jit_pre_approvals_issue_id_idx").on(table.issueId),
    statusIdx: index("jit_pre_approvals_status_idx").on(table.status),
    expiresAtIdx: index("jit_pre_approvals_expires_at_idx").on(table.expiresAt),
  }),
);
