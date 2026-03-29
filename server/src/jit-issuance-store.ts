import { randomUUID } from "node:crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { jitIssuances } from "@paperclipai/db";

export type IssuanceEntry = {
  payload: Record<string, unknown>;
  issueId: string;
  createdAt: number;
  expiresAt: number;
};

// Module-level db reference, set once via initIssuanceStore().
let _db: Db | null = null;

// In-memory fallback store (used when DB is unavailable or as test fallback).
const memStore = new Map<string, IssuanceEntry>();

export function initIssuanceStore(db: Db): void {
  _db = db;
}

export function createIssuanceId(): string {
  return randomUUID();
}

export async function storeIssuance(
  issuanceId: string,
  payload: Record<string, unknown>,
  issueId: string,
  ttlMs: number,
): Promise<void> {
  const now = Date.now();
  const expiresAt = now + ttlMs;

  if (_db) {
    try {
      await _db.insert(jitIssuances).values({
        id: issuanceId,
        issueId,
        payload,
        expiresAt: new Date(expiresAt),
        createdAt: new Date(now),
      });
      return;
    } catch {
      // DB insert failed (e.g. table doesn't exist yet) — fall back to in-memory
    }
  }

  // Fallback: in-memory (original behavior)
  memStore.set(issuanceId, {
    payload,
    issueId,
    createdAt: now,
    expiresAt,
  });
  setTimeout(() => {
    memStore.delete(issuanceId);
  }, ttlMs).unref();
}

/**
 * Resolve an issuance by ID. Returns the payload and marks as resolved (one-time use).
 * Returns null if not found, expired, or already resolved.
 */
export async function resolveIssuance(issuanceId: string): Promise<IssuanceEntry | null> {
  if (_db) {
    try {
      const rows = await _db
        .select()
        .from(jitIssuances)
        .where(
          and(
            eq(jitIssuances.id, issuanceId),
            isNull(jitIssuances.resolvedAt),
            gt(jitIssuances.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (rows.length === 0) {
        // Also check in-memory fallback (for entries stored before DB was ready)
        return _resolveFromMemory(issuanceId);
      }

      const row = rows[0];

      // Mark as resolved (one-time use)
      await _db
        .update(jitIssuances)
        .set({ resolvedAt: new Date() })
        .where(eq(jitIssuances.id, issuanceId));

      return {
        payload: row.payload as Record<string, unknown>,
        issueId: row.issueId,
        createdAt: new Date(row.createdAt).getTime(),
        expiresAt: new Date(row.expiresAt).getTime(),
      };
    } catch {
      // DB query failed — fall back to in-memory
    }
  }

  return _resolveFromMemory(issuanceId);
}

function _resolveFromMemory(issuanceId: string): IssuanceEntry | null {
  const entry = memStore.get(issuanceId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memStore.delete(issuanceId);
    return null;
  }
  memStore.delete(issuanceId);
  return entry;
}

/** Visible for testing. Resets in-memory store and DB reference. */
export function _clearIssuanceStore(): void {
  memStore.clear();
  _db = null;
}
