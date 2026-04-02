/**
 * Server-side allowlisted target registry for JIT SSH token issuance.
 *
 * Each entry maps a short machine name to its issuer base URL and default
 * options. The registry is populated from the JIT_TARGET_REGISTRY env var
 * (JSON) with a built-in fallback for the three canonical targets.
 */

import { z } from "zod";

// ── Schema for a single target entry ────────────────────────────────
export const jitTargetEntrySchema = z.object({
  /** Human-readable label shown in the UI / comments. */
  label: z.string().min(1),
  /** Base URL of the issuer service (e.g. agent-access instance). */
  issuerBaseUrl: z.string().url(),
  /** Default principal to request when none is specified. */
  defaultPrincipal: z.string().min(1).default("agent"),
  /** Default TTL in minutes. */
  defaultTtlMinutes: z.number().int().positive().default(60),
  /** Brief connection guide included in token payloads so agents know how to connect. */
  connectionGuide: z.string().optional(),
});

export type JitTargetEntry = z.infer<typeof jitTargetEntrySchema>;

export const jitTargetRegistrySchema = z.record(z.string().min(1), jitTargetEntrySchema);

export type JitTargetRegistry = z.infer<typeof jitTargetRegistrySchema>;

// ── Issuance request payload (sent by the client) ───────────────────
export const jitIssuanceRequestSchema = z.object({
  /** Which registered machine to target (e.g. "work.int"). */
  target: z.string().min(1),
  /** SSH principal / permission set. Falls back to target default. */
  principal: z.string().min(1).optional(),
  /** Certificate TTL in minutes. Falls back to target default. */
  ttlMinutes: z.number().int().positive().max(1440).optional(),
  /** Arbitrary per-target options forwarded to the issuer. */
  options: z.record(z.unknown()).optional(),
});

export type JitIssuanceRequest = z.infer<typeof jitIssuanceRequestSchema>;

// ── Registry loading ────────────────────────────────────────────────

// ── Inline connection guides (travel with every token payload) ──────
// Keep these concise — they're embedded in JSON comments/responses.
// Full reference: CONNECT.md on each host.

const CONNECTION_GUIDE_WORK_INT = [
  "## Quick Connection Guide — work.int",
  "You are operating as `agent` in jeffhollan's user space (macOS, Apple Silicon).",
  "ALWAYS use jit_connect.py for commands — never raw SSH or tmux.",
  "",
  "Run commands:  jit_connect.py --issue-id $ISSUE_ID -- <command>",
  "Tmux window:   jit_connect.py --issue-id $ISSUE_ID --tmux-window <name>",
  "Tmux socket:   /Users/jeffhollan/.tmux-shared/bridge",
  "Tmux binary:   /opt/homebrew/bin/tmux",
  "",
  "You do NOT have sudo. To request elevated access:",
  "  Paperclip issue: use issue_topic.py to message Jeff, set issue to blocked",
  "  Ad-hoc: message Jeff via Telegram with what you need and why",
  "",
  "Do NOT: run raw tmux/SSH, chmod files, modify shell profiles, kill other processes.",
  "Full guide: cat ~/CONNECT.md",
].join("\n");

const CONNECTION_GUIDE_PC_INT = [
  "## Quick Connection Guide — pc.int",
  "You are operating as `agent` in jeffhollan's user space (Linux/Ubuntu).",
  "ALWAYS use jit_connect.py for commands — never raw SSH or tmux.",
  "NOTE: SSH port is 2222 (not 22).",
  "",
  "Run commands:  jit_connect.py --issue-id $ISSUE_ID --target pc.int -- <command>",
  "Tmux window:   jit_connect.py --issue-id $ISSUE_ID --target pc.int --tmux-window <name>",
  "Tmux socket:   /run/tmux-shared/bridge",
  "",
  "You do NOT have sudo. To request elevated access:",
  "  Paperclip issue: use issue_topic.py to message Jeff, set issue to blocked",
  "  Ad-hoc: message Jeff via Telegram with what you need and why",
  "",
  "Do NOT: run raw tmux/SSH, chmod files, modify shell profiles, kill other processes.",
  "Full guide: cat ~/CONNECT.md",
].join("\n");

const CONNECTION_GUIDE_ARCH_INT = [
  "## Quick Connection Guide — arch.int",
  "You are operating as `agent` in jeffhollan's user space (Linux/Arch).",
  "ALWAYS use jit_connect.py for commands — never raw SSH or tmux.",
  "",
  "Run commands:  jit_connect.py --issue-id $ISSUE_ID --target arch.int -- <command>",
  "Tmux window:   jit_connect.py --issue-id $ISSUE_ID --target arch.int --tmux-window <name>",
  "Tmux socket:   /tmp/tmux-1000/default",
  "",
  "You do NOT have sudo. To request elevated access:",
  "  Paperclip issue: use issue_topic.py to message Jeff, set issue to blocked",
  "  Ad-hoc: message Jeff via Telegram with what you need and why",
  "",
  "Do NOT: run raw tmux/SSH, chmod files, modify shell profiles, kill other processes.",
  "Full guide: cat ~/CONNECT.md",
].join("\n");

function buildFallbackRegistry(): JitTargetRegistry {
  const baseUrl = process.env.AGENT_ACCESS_BASE_URL;
  if (!baseUrl) return {};
  return {
    "work.int": {
      label: "Work",
      issuerBaseUrl: baseUrl,
      defaultPrincipal: "agent",
      defaultTtlMinutes: 60,
      connectionGuide: CONNECTION_GUIDE_WORK_INT,
    },
    "pc.int": {
      label: "Paperclip",
      issuerBaseUrl: baseUrl,
      defaultPrincipal: "agent",
      defaultTtlMinutes: 60,
      connectionGuide: CONNECTION_GUIDE_PC_INT,
    },
    "arch.int": {
      label: "Arch",
      issuerBaseUrl: baseUrl,
      defaultPrincipal: "agent",
      defaultTtlMinutes: 60,
      connectionGuide: CONNECTION_GUIDE_ARCH_INT,
    },
  };
}

let cachedRegistry: JitTargetRegistry | null = null;

export function loadJitTargetRegistry(): JitTargetRegistry {
  if (cachedRegistry) return cachedRegistry;

  const envJson = process.env.JIT_TARGET_REGISTRY;
  if (envJson) {
    try {
      cachedRegistry = jitTargetRegistrySchema.parse(JSON.parse(envJson));
    } catch {
      throw new Error("Invalid JIT_TARGET_REGISTRY env var – must be valid JSON matching the target schema");
    }
  } else {
    cachedRegistry = buildFallbackRegistry();
  }
  return cachedRegistry;
}

/** Look up a single target. Returns undefined when the target is not allowlisted. */
export function getJitTarget(targetName: string): JitTargetEntry | undefined {
  return loadJitTargetRegistry()[targetName];
}

/** Return the list of allowlisted target names. */
export function listJitTargets(): string[] {
  return Object.keys(loadJitTargetRegistry());
}

/** Clear cached registry (useful for tests). */
export function resetJitTargetRegistryCache(): void {
  cachedRegistry = null;
}
