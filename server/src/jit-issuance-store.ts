import { randomUUID } from "node:crypto";

export type IssuanceEntry = {
  payload: Record<string, unknown>;
  issueId: string;
  createdAt: number;
  expiresAt: number;
};

const store = new Map<string, IssuanceEntry>();

export function createIssuanceId(): string {
  return randomUUID();
}

export function storeIssuance(
  issuanceId: string,
  payload: Record<string, unknown>,
  issueId: string,
  ttlMs: number,
): void {
  const now = Date.now();
  store.set(issuanceId, {
    payload,
    issueId,
    createdAt: now,
    expiresAt: now + ttlMs,
  });

  // Schedule cleanup after TTL.
  setTimeout(() => {
    store.delete(issuanceId);
  }, ttlMs).unref();
}

/**
 * Resolve an issuance by ID. Returns the payload and deletes the entry (one-time use).
 * Returns null if not found or expired.
 */
export function resolveIssuance(issuanceId: string): IssuanceEntry | null {
  const entry = store.get(issuanceId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(issuanceId);
    return null;
  }
  store.delete(issuanceId);
  return entry;
}

/** Visible for testing. */
export function _clearIssuanceStore(): void {
  store.clear();
}
