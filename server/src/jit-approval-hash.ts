import { createHash } from "node:crypto";

export interface JitApprovalParams {
  issueId: string;
  target: string;
  principal: string;
  ttlMinutes: number;
  shareTmux: boolean;
  assigneeAgentId: string | null;
}

export function computeJitApprovalHash(params: JitApprovalParams): string {
  const canonical = JSON.stringify([
    params.issueId,
    params.target,
    params.principal,
    params.ttlMinutes,
    params.shareTmux,
    params.assigneeAgentId ?? "",
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
