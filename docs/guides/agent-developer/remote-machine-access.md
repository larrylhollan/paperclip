---
title: Remote Machine Access for Agents
summary: How Paperclip/OpenClaw agents should access Jeff's internal machines, what each host is for, and where the current context gaps are.
---

This runbook exists to make remote-machine work less fragile for agent-driven tasks like HOL-42.

## Scope

Hosts called out in current work:

- `work.int.hollan.dev`
- `pc.int`
- `arch.int.hollan.dev`

## Access pattern: ephemeral SSH credentials

Use short-lived SSH credentials fetched from Jeff's one-time URL flow.

### Preferred issue-bound flow

When a Paperclip issue has a JIT SSH token attached, consume it from the issue comments instead of expecting the fetch URL to be pasted inline in chat.

1. Read `GET /api/issues/{issueId}/comments`.
2. Scan newest-first for the `<!-- jit-ssh-token -->` comment block.
3. Normalize canonical snake_case fields plus legacy aliases (`fetch_url` / `fetchUrl`, `expires_at` / `expiresAt`, etc.).
4. Use the newest non-expired token.
5. If a token is provisioned through the Paperclip UI, expect the assignee to be woken with `jit_ssh_token_provisioned`, but still re-read issue comments as the source of truth.

Canonical payload fields now include:
- `target` / `target_label`
- `fetch_url`
- `principal`
- `ttl_minutes`
- `ssh_host` / `ssh_user`
- `cert_id`
- `issued_at` / `expires_at`
- `issued_options`

### Standard flow

1. Get a fresh one-time fetch URL.
2. Fetch the JSON payload:

```bash
curl -sk "<FETCH_URL>" > /tmp/agent-creds.json
```

3. Materialize the key and cert:

```bash
jq -r '.private_key' < /tmp/agent-creds.json > /tmp/agent_key
chmod 600 /tmp/agent_key
jq -r '.certificate' < /tmp/agent-creds.json > /tmp/agent_key-cert.pub
```

4. Run one SSH command per invocation:

```bash
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o CertificateFile=/tmp/agent_key-cert.pub \
  -i /tmp/agent_key \
  <ssh_user>@<ssh_host> '<command>'
```

Prefer `ssh_user` / `ssh_host` from the credential JSON when present.

### Principal / privilege model

Use the lowest privilege that fits the task:

- `agent-read` — inspection only (`ls`, `cat`, `grep`, `find`, `head`, `tail`, `stat`, `df`, `du`)
- `agent-web` — normal dev / deploy work (`git`, `mkdir`, `cp`, `mv`, `node`, `npm`, `python`, `curl`, `docker`, `make`), **no sudo**
- `agent-admin` — only when you truly need privileged changes or sudo

Default to **`agent-web`** for real engineering work. Ask for a fresh higher-privilege token if the task actually needs it.

### Operational rules

- Tokens are short-lived; if auth fails, fetch a new one instead of retrying blindly.
- Keep key/cert material in `/tmp`, not in repos.
- There is no persistent shell — multi-step work should be separate SSH invocations.
- For writes, prefer heredoc or `tee` patterns.

## Host quick-reference

### `work.int.hollan.dev`

Use this as the **default remote coding host**.

Confirmed current role/capabilities:

- Jeff's work MacBook
- best host for interactive coding / watching ongoing work
- preferred path for tmux-visible remote sessions
- existing Claude / Copilot notification plumbing is already set up here

Confirmed current details:

- tmux socket: `/tmp/tmux-501/default` (also `/private/tmp/tmux-501/default`)
- Jeff home: `/Users/jeffhollan`
- Claude binary: `/Users/jeffhollan/.local/bin/claude`
- wrappers: `~/.local/bin/ccwatch`, `~/.local/bin/cpwatch`, `~/.local/bin/agent-run`, `~/.local/bin/agent-notify`
- Claude hooks config: `~/.claude/settings.json`
- notify config: `~/.config/agent-notify/config.json`
- screen bridge client: `/usr/local/bin/screen-bridge`

Use `work.int.hollan.dev` when:

- you need live coding in tmux
- Jeff wants to watch / steer the run
- you need Claude Code or Copilot CLI with notify hooks
- you need remote UI observation (screen bridge / Peekaboo style flows)

Recommended pattern:

- get a fresh ephemeral SSH token
- prefer tmux-first workflows
- prefer `ccwatch --label <name>` or `agent-run --label <name> -- claude ...`
- keep Jeff desktop notifications global/default on the work machine
- keep Larry/chat wake-ups opt-in for watched runs

### `pc.int`

Treat this as the **Email Assistant deploy / validation target**, not the default brainstorming box.

Confirmed current role/capabilities from the Email Assistant work:

- practical v1 target for the local Python mail broker
- has **Python + Azure CLI (`az`)**
- does **not** currently have Node/npm or Azure Functions Core Tools installed
- Windows `az.cmd` is the reliable path for real connector / ARM token work
- Linux `/usr/bin/az` can see profile state but is not the reliable connector path

Use `pc.int` when:

- you are deploying or validating the Email Assistant / `pc-mail-broker`
- you need the real Office365 connector environment that was already proven there
- you need to smoke-test the bounded local-context Copilot path tied to HOL-42

Recommended pattern:

- use bounded SSH commands for deploy / smoke-test tasks
- do not assume a full Node-based toolchain exists there
- treat Windows Azure CLI interop as the proven path for connector calls
- if the goal is exploratory coding, do it elsewhere first; use `pc.int` for environment-truth validation

### `arch.int.hollan.dev`

Treat this as the **home / infra box** and use a narrower blast radius.

Confirmed current capabilities associated with Jeff's Arch-side home infra in Larry's notes:

- Arcade control service (Batocera / parental lock flow)
- Homebridge host / API access for home automation

Use `arch.int.hollan.dev` when:

- you are working on home-infra or local services tied to Jeff's Arch environment
- you need to inspect or modify infra-style services rather than do general remote coding

Recommended pattern:

- start with `agent-read` unless a real write is needed
- prefer single-purpose commands over open-ended exploratory work
- verify service locations after login before making changes
- escalate to `agent-admin` only if privileged service changes are actually necessary

## Which host should an agent choose?

| Need | Preferred host |
|---|---|
| interactive remote coding, tmux, Claude/Copilot watching | `work.int.hollan.dev` |
| Email Assistant deploy / smoke test / connector-truth validation | `pc.int` |
| home infra / arcade / Homebridge / arch-side services | `arch.int.hollan.dev` |

## Current Paperclip agent-context assessment

### What is already good

Larry's local/OpenClaw environment already has strong remote-work guidance and tooling:

- ephemeral SSH skill flow exists
- remote coding runbook exists
- tmux / notify / screen-bridge details for `work.int.hollan.dev` are already documented
- Email Assistant README already captures key `pc.int` constraints

### The important gap

Paperclip's default instruction bundle for **non-CEO agents** currently loads only:

- `AGENTS.md`

while the CEO default bundle loads:

- `AGENTS.md`
- `HEARTBEAT.md`
- `SOUL.md`
- `TOOLS.md`

That means host-specific SSH/token/tmux knowledge living in `TOOLS.md` is **not automatically available to many non-CEO agents** unless their adapter config or skill set explicitly includes it.

Practical effect:

- an Engineering-style agent may know the general heartbeat/task loop
- but still miss the host-choice rules, token flow, tmux conventions, or `pc.int` environment constraints needed to finish tasks like HOL-42 cleanly

## Recommendations

To make Engineering and similar agents reliably successful:

1. **Expose this runbook (or equivalent content) to the relevant agent instruction path / skill bundle**, not just Larry's private notes.
2. For agents expected to do remote coding, include:
   - the ephemeral SSH flow
   - principal-selection guidance (`agent-read` / `agent-web` / `agent-admin`)
   - host-selection rules for `work.int`, `pc.int`, and `arch.int`
3. For HOL-42 specifically, ensure the executing agent knows that:
   - `pc.int` is the deploy/smoke-test target
   - `pc.int` does not have the same general-purpose toolchain as the work MacBook
   - `work.int.hollan.dev` is the preferred place for iterative coding / watched runs
4. If an agent only has the default non-CEO instruction bundle, do **not** assume it automatically inherits TOOLS-level operational detail.

## Upgrade durability for the current JIT SSH setup

### Short answer

**Today, this setup is local source work, not an upgrade-proof extension.**

If Paperclip is upgraded by replacing the local app bundle / source checkout with a fresh release that does **not** already include these changes, the current JIT SSH work can be wiped out.

If the changes are merged into upstream Paperclip and the upgraded version includes them, then normal upgrades are fine. Until then, treat this as a **local customization that needs either merge-forwarding or restore steps**.

### Why this is currently upgrade-sensitive

The current work is implemented directly in Paperclip server/UI source files rather than living entirely in a separately versioned plugin package.

Current local implementation areas include:

- OpenClaw gateway adapter execution and docs
  - `packages/adapters/openclaw-gateway/src/server/execute.ts`
  - `packages/adapters/openclaw-gateway/src/server/execute.test.ts`
  - `packages/adapters/openclaw-gateway/README.md`
- Paperclip server-side JIT token issuance / issue attachment flow
  - `server/src/routes/issues.ts`
  - `server/src/jit-target-registry.ts`
  - `server/src/__tests__/jit-ssh-token-routes.test.ts`
  - `server/src/__tests__/openclaw-gateway-adapter.test.ts`
- Paperclip UI support for requesting / exposing issue-bound access
  - `ui/src/api/issues.ts`
  - `ui/src/pages/IssueDetail.tsx`
  - `ui/src/components/IssueHeaderActions.tsx`
  - `ui/src/components/IssueHeaderActions.test.tsx`
- Supporting local test/build config touched during this work
  - `ui/vite.config.ts`
  - `vitest.config.ts`

Because these are core-source edits, a reinstall/reset/upgrade that replaces the tree can remove them unless they are already present in the target version or deliberately re-applied.

### More durable alternatives considered

1. **Best long-term option: upstream the feature into Paperclip proper**
   - This is the cleanest answer if the JIT SSH + mobile issue-actions flow is intended to remain a first-class capability.
   - Once included in a released version, upgrades become normal.

2. **Plugin/launcher-based UI for some surfaces**
   - Paperclip's plugin model can provide issue-level toolbar/context actions.
   - That could reduce future core-UI patching for some affordances.
   - However, the current JIT SSH capability also depends on server/API behavior, so a plugin-only rewrite would not eliminate all core integration work by itself.

### COO upgrade / restore checklist

If COO upgrades Paperclip **before these changes are in the target release**, use this checklist:

1. **Check whether the target version already contains the feature**
   - confirm the issue page still exposes **Grant SSH Access**
   - confirm mobile issue detail still exposes an obvious **Actions** path
   - confirm issue comments still carry the `<!-- jit-ssh-token -->` credential block flow

2. **If the feature is missing, restore the local customization**
   - re-apply the JIT SSH source changes in the files listed above
   - re-apply the mobile issue-actions UI component:
     - `ui/src/components/IssueHeaderActions.tsx`
     - `ui/src/pages/IssueDetail.tsx`
     - `ui/src/components/IssueHeaderActions.test.tsx`
   - re-apply this runbook if it was lost

3. **Run validation after restore**

```bash
pnpm test:run ui/src/components/IssueHeaderActions.test.tsx
pnpm --filter @paperclipai/ui typecheck
```

If the broader JIT SSH server/adapter work was also restored, additionally run the relevant server/adapter tests for the target branch.

4. **Smoke-test in the UI**
   - open an issue on desktop and confirm **Grant SSH Access** is present
   - open the same issue at mobile width and confirm **Actions** is visible
   - request a token and confirm the issue receives the credential comment block

### Practical guidance for future upgrades

Before asking COO to upgrade, do one of these:

- **preferred:** merge/release these changes upstream first
- or keep a small tracked patch/cherry-pick set for the files above
- or explicitly run the restore checklist immediately after upgrade

Do **not** assume a generic Paperclip upgrade will preserve unmerged local edits.

## Source material used for this runbook

- `skills/ephemeral-ssh-access/SKILL.md`
- `REMOTE_CODING_RUNBOOK.md`
- `memory/reference-tools.md`
- `projects/pc-mail-broker/README.md`
- `server/src/services/default-agent-instructions.ts`
