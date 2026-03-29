import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const jitIssuances = pgTable(
  "jit_issuances",
  {
    id: uuid("id").primaryKey(),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdIdx: index("jit_issuances_issue_id_idx").on(table.issueId),
    expiresAtIdx: index("jit_issuances_expires_at_idx").on(table.expiresAt),
  }),
);
