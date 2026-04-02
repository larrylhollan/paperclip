#!/usr/bin/python3
"""
HOL-135 patch for agent-access-service.py

This file contains ONLY the new/changed components for ticket verification.
Apply these changes to /opt/agent-access/src/agent-access-service.py on
work.int and pc.int.

Changes:
  1. New module-level: ApprovalTicketVerifier class + TICKET_VERIFIER global
  2. Modified: _handle_sign_for_issue() to verify approval tickets
  3. Modified: main() to initialize TICKET_VERIFIER
"""

import hashlib
import hmac
import json
import time
import threading


# ---------------------------------------------------------------------------
# Approval Ticket Verifier (NEW — HOL-135)
# ---------------------------------------------------------------------------

class ApprovalTicketVerifier:
    """Verifies HMAC-SHA256 signed approval tickets from Paperclip server.

    The ticket proves that Jeff specifically approved this exact JIT issuance
    request. Without a valid ticket, sign-for-issue is rejected (when the
    shared secret is configured).
    """

    def __init__(self, secret):
        """
        Args:
            secret: Shared HMAC secret (same as AGENT_ACCESS_TICKET_SECRET
                    on the Paperclip server). If None/empty, verification
                    is disabled (backward-compatible bearer-only mode).
        """
        self.secret = secret
        self.enabled = bool(secret)
        # Nonce replay protection: set of (nonce, expiry_time) pairs
        self._seen_nonces = {}  # nonce -> expires_at_epoch
        self._nonce_lock = threading.Lock()
        # Start cleanup thread
        if self.enabled:
            t = threading.Thread(target=self._nonce_cleanup_loop, daemon=True)
            t.start()

    def verify(self, ticket, request_issue_id, request_params):
        """Verify an approval ticket.

        Args:
            ticket: dict with keys: approvalId, approvedByUserId, issueId,
                    paramsHash, approvedAt, expiresAt, nonce, signature
            request_issue_id: issueId from the sign-for-issue request body
            request_params: dict with keys needed for local params hash
                           computation (issueId, target, principal,
                           ttlMinutes, shareTmux, assigneeAgentId)

        Returns:
            (ok: bool, error: str or None, audit_meta: dict)
        """
        if not self.enabled:
            return True, None, {}

        if not ticket or not isinstance(ticket, dict):
            return False, "approvalTicket is required", {}

        # Extract fields
        required_fields = [
            "approvalId", "approvedByUserId", "issueId",
            "paramsHash", "approvedAt", "expiresAt", "nonce", "signature",
        ]
        for field in required_fields:
            if field not in ticket:
                return False, "approvalTicket missing field: %s" % field, {}

        audit_meta = {
            "approvalId": ticket["approvalId"],
            "approvedByUserId": ticket["approvedByUserId"],
        }

        # 1. Verify signature
        canonical = json.dumps([
            ticket["approvalId"],
            ticket["approvedByUserId"],
            ticket["issueId"],
            ticket["paramsHash"],
            ticket["approvedAt"],
            ticket["expiresAt"],
            ticket["nonce"],
        ], separators=(",", ":"))
        expected_sig = hmac.new(
            self.secret.encode(), canonical.encode(), hashlib.sha256
        ).hexdigest()

        if not hmac.compare_digest(ticket["signature"], expected_sig):
            return False, "Invalid ticket signature", audit_meta

        # 2. Verify expiry
        try:
            # Parse ISO timestamp — handle both Z suffix and +00:00
            expires_str = ticket["expiresAt"]
            if expires_str.endswith("Z"):
                expires_str = expires_str[:-1] + "+00:00"
            from datetime import datetime, timezone
            expires_at = datetime.fromisoformat(expires_str)
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            expires_epoch = expires_at.timestamp()
        except (ValueError, TypeError) as e:
            return False, "Invalid expiresAt: %s" % str(e), audit_meta

        if time.time() > expires_epoch:
            return False, "Ticket has expired", audit_meta

        # 3. Verify nonce uniqueness (replay protection)
        with self._nonce_lock:
            if ticket["nonce"] in self._seen_nonces:
                return False, "Ticket nonce already used (replay)", audit_meta
            self._seen_nonces[ticket["nonce"]] = expires_epoch

        # 4. Verify issueId matches request
        if ticket["issueId"] != request_issue_id:
            return False, "Ticket issueId mismatch", audit_meta

        # 5. Verify params hash matches request parameters
        local_hash = self._compute_params_hash(request_params)
        if ticket["paramsHash"] != local_hash:
            return (
                False,
                "Ticket paramsHash mismatch (request parameters changed)",
                audit_meta,
            )

        return True, None, audit_meta

    @staticmethod
    def _compute_params_hash(params):
        """Compute the same deterministic hash as the TypeScript side.

        Must match computeJitApprovalHash() in jit-approval-hash.ts:
          JSON.stringify([issueId, target, principal, ttlMinutes,
                          assigneeAgentId ?? ""])
        """
        canonical = json.dumps([
            params.get("issueId", ""),
            params.get("target", ""),
            params.get("principal", ""),
            params.get("ttlMinutes", 0),
            params.get("assigneeAgentId") or "",
        ], separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()

    def _nonce_cleanup_loop(self):
        """Periodically clean up expired nonces."""
        while True:
            time.sleep(60)
            now = time.time()
            with self._nonce_lock:
                expired = [
                    nonce for nonce, exp in self._seen_nonces.items()
                    if now > exp
                ]
                for nonce in expired:
                    del self._seen_nonces[nonce]


# ---------------------------------------------------------------------------
# PATCHED: _handle_sign_for_issue
# ---------------------------------------------------------------------------
# Replace the existing _handle_sign_for_issue method in AgentAccessHandler
# with this version.

def _handle_sign_for_issue_PATCHED(self):
    """Handle POST /sign-for-issue with approval ticket verification."""
    try:
        body = self._read_body()
        params = json.loads(body) if body else {}
    except json.JSONDecodeError:
        self._send_json(400, {"error": "Invalid JSON"})
        return

    issue_id = params.get("issueId") or params.get("issue_id", "")
    if not issue_id:
        self._send_json(400, {"error": "issueId required"})
        return

    principal = params.get("principal", "agent-web")
    ttl_minutes = params.get("ttl_minutes", 120)
    comment = params.get("comment", "")
    source_address = params.get("source_address", "10.0.0.4")
    tmux_user = params.get("tmux_user") or None
    screen_user = params.get("screen_user") or None
    share_tmux = bool(tmux_user)
    share_screen = bool(screen_user)

    # --- HOL-135: Approval ticket verification ---
    if TICKET_VERIFIER and TICKET_VERIFIER.enabled:
        ticket = params.get("approvalTicket")
        ticket_params = {
            "issueId": issue_id,
            "target": params.get("target", ""),
            "principal": principal,
            "ttlMinutes": ttl_minutes,
            "shareTmux": params.get("shareTmux", False),
            "assigneeAgentId": params.get("assigneeAgentId") or None,
        }
        ok, error, audit_meta = TICKET_VERIFIER.verify(
            ticket, issue_id, ticket_params,
        )
        if not ok:
            AUDIT.log(
                "sign_for_issue_ticket_rejected",
                issue_id=issue_id,
                error=error,
                **audit_meta,
            )
            self._send_json(403, {"error": error})
            return
        # Ticket valid — include approval metadata in audit
        AUDIT.log(
            "sign_for_issue_ticket_verified",
            issue_id=issue_id,
            **audit_meta,
        )
    # --- End HOL-135 ---

    if not self._validate_sign_request(principal, ttl_minutes):
        return

    ok, msg = RATE_LIMITER.check()
    if not ok:
        self._send_json(429, {"error": msg})
        return

    try:
        privkey, pubkey_data, cert_data, cert_id = SIGNER.generate_keypair_and_sign(
            principal, ttl_minutes, comment, source_address,
            tmux_user=tmux_user if share_tmux else None,
            screen_user=screen_user if share_screen else None,
            issue_id=issue_id,
        )
        RATE_LIMITER.record_sign()
        AUDIT.log("cert_signed", cert_id=cert_id, principal=principal,
                  ttl=ttl_minutes, flow="keypair_generated_for_issue",
                  issue_id=issue_id)

        result = {
            "cert_id": cert_id,
            "private_key": privkey,
            "public_key": pubkey_data,
            "certificate": cert_data,
            "principal": principal,
            "ttl_minutes": ttl_minutes,
            "source_address": source_address,
            "ssh_user": CONFIG["defaults"]["ssh_user"],
            "ssh_host": CONFIG["defaults"]["ssh_host"],
            "issueId": issue_id,
        }

        code = FETCH_STORE.put(result, cert_id=cert_id)
        fetch_url = self._build_fetch_url(code)
        response = {
            "cert_id": cert_id,
            "fetch_url": fetch_url,
            "fetch_expires_seconds": CONFIG["limits"]["fetch_code_ttl_seconds"],
            "issueId": issue_id,
            "note": "Private key included in fetch payload",
        }
        self._send_json(200, response)

        if share_tmux:
            tmux_ok, tmux_msg = _tmux_share(tmux_user, ttl_minutes, cert_id)
            if not tmux_ok:
                AUDIT.log("tmux_share_failed", cert_id=cert_id, error=tmux_msg,
                          issue_id=issue_id)
            else:
                AUDIT.log("tmux_share_started", cert_id=cert_id,
                          user=tmux_user, ttl=ttl_minutes, issue_id=issue_id)

        if share_screen:
            screen_ok, screen_msg = _screen_arm(screen_user, ttl_minutes, cert_id)
            if not screen_ok:
                AUDIT.log("screen_arm_failed", cert_id=cert_id, error=screen_msg,
                          issue_id=issue_id)
            else:
                AUDIT.log("screen_bridge_armed", cert_id=cert_id,
                          user=screen_user, ttl=ttl_minutes, issue_id=issue_id)

    except Exception as e:
        AUDIT.log("sign_error", error=str(e), issue_id=issue_id)
        self._send_json(500, {"error": "Signing failed: %s" % str(e)})


# ---------------------------------------------------------------------------
# PATCHED: main() additions
# ---------------------------------------------------------------------------
# Add to main() after loading CONFIG and BEARER_TOKEN:
#
#   global TICKET_VERIFIER
#   ticket_secret = os.environ.get("AGENT_ACCESS_TICKET_SECRET", "").strip()
#   if not ticket_secret:
#       ticket_secret = CONFIG.get("auth", {}).get("ticket_secret", "")
#   TICKET_VERIFIER = ApprovalTicketVerifier(ticket_secret)
#   if TICKET_VERIFIER.enabled:
#       AUDIT.log("ticket_verification_enabled")
#   else:
#       AUDIT.log("ticket_verification_disabled",
#                 note="AGENT_ACCESS_TICKET_SECRET not set, bearer-only mode")

TICKET_VERIFIER = None  # initialized in main()
