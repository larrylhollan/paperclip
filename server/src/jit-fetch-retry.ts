/**
 * Resilient fetch wrapper for JIT SSH token signing requests.
 *
 * The remote agent-access server on pc.int runs Python BaseHTTPServer (HTTP/1.0)
 * which sends `Connection: close` on every response. Node.js v24's undici keeps
 * idle TLS connections in its pool and may try to reuse a socket that the remote
 * side has already torn down — causing `SocketError: other side closed`.
 *
 * This wrapper retries the fetch up to `maxRetries` times when the error is a
 * transient connection-pool race ("other side closed", ECONNRESET, etc.).
 */

import { logger } from "./middleware/logger.js";

const RETRYABLE_CAUSES = [
  "other side closed",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
];

function isRetryable(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = String((err as any)?.cause?.message ?? err.message ?? "");
  return RETRYABLE_CAUSES.some((c) => msg.includes(c));
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: { maxRetries?: number; label?: string },
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 2;
  const label = opts?.label ?? "sign-for-issue";

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRetryable(err)) {
        const delay = 250 * 2 ** attempt; // 250ms, 500ms
        logger.warn(
          { err, attempt: attempt + 1, maxRetries, url, label },
          `${label}: transient fetch error, retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  // Should not reach here, but satisfy TypeScript
  throw lastErr;
}
