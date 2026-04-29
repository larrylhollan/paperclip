import { z } from "zod";

export const createJitPreApprovalSchema = z.object({
  records: z.array(z.object({
    target: z.string().min(1),
    role: z.string().min(1),
    reason: z.string().min(1),
  })).min(1).max(20),
});

export type CreateJitPreApproval = z.infer<typeof createJitPreApprovalSchema>;

export const updateJitPreApprovalStatusSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  approvedByUserId: z.string().optional().default("board"),
});

export type UpdateJitPreApprovalStatus = z.infer<typeof updateJitPreApprovalStatusSchema>;

export const exchangeJitPreApprovalSchema = z.object({
  runId: z.string().uuid(),
});

export type ExchangeJitPreApproval = z.infer<typeof exchangeJitPreApprovalSchema>;
