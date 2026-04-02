import { createHash } from "node:crypto";

export interface JitApprovalParams {
  issueId: string;
  target: string;
  principal: string;
  ttlMinutes: number;
  assigneeAgentId: string | null;
}

export function computeJitApprovalHash(params: JitApprovalParams): string {
  const canonical = JSON.stringify([
    params.issueId,
    params.target,
    params.principal,
    params.ttlMinutes,
    params.assigneeAgentId ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
