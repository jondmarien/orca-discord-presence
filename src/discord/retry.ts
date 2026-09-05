/**
 * Discord IPC connect retry: capped exponential backoff and error classes.
 *
 * The same class of Discord IPC pitfall showed up in another Discord Rich
 * Presence app (Java / Burp Suite): Discord can be slow to READY, and a
 * pipe-open-but-not-ready handshake should be retried, not treated as fatal.
 * Same hardening here — 3 attempts, 3s → 15s capped backoff. This client
 * does not use DiscordIPC or any Java library.
 *
 * Missing-socket failures are **not** retried here so the opt-in companion
 * bridge (#6) still fails over immediately when no local Discord is present.
 *
 * @module discord/retry
 * @author Jonathan Marien
 * @date 2026-09-05
 */

/**
 * How many `connect()` attempts to make when the handshake is retryable.
 */
export const CONNECT_RETRY_ATTEMPTS = 3

/**
 * Delay after the first failed retryable attempt (milliseconds).
 */
export const CONNECT_RETRY_INITIAL_MS = 3_000

/**
 * Cap for the exponential backoff (milliseconds).
 */
export const CONNECT_RETRY_MAX_MS = 15_000

/**
 * Handshake completed with `evt: READY` but `data` was null/missing.
 *
 * Discord can accept the pipe before the user session is authenticated.
 * A prior Discord RPC integration hit a null `data` crash on that race;
 * we treat it as retryable instead of fatal.
 */
export class HandshakeNotReadyError extends Error {
  constructor(
    message = 'Discord IPC handshake returned null data — the client may not be fully initialized. Retry after Discord is fully loaded.'
  ) {
    super(message)
    this.name = 'HandshakeNotReadyError'
  }
}

/**
 * Backoff delay after a failed attempt:
 * `min(INITIAL * 2^(attempt-1), MAX)` (3s → 15s cap).
 *
 * @param failedAttempt - 1-based attempt that just failed (1 → 3s, 2 → 6s).
 * @returns Delay in milliseconds before the next attempt.
 */
export function connectRetryDelayMs(failedAttempt: number): number {
  const shift = Math.max(0, failedAttempt - 1)
  return Math.min(CONNECT_RETRY_INITIAL_MS * 2 ** shift, CONNECT_RETRY_MAX_MS)
}

/**
 * Discord rejected the Application ID (unregistered / HTTP 404).
 *
 * Do not retry — the next attempt will fail the same way.
 */
export function isFatalAppIdError(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('invalid application') ||
    lower.includes('unknown application')
  )
}

/**
 * Whether a failed `connect()` should be retried with backoff.
 *
 * Retry: handshake not ready, handshake timeout, peer close during handshake.
 * Do not retry: missing IPC socket (bridge failover), invalid App ID, 404.
 */
export function isRetryableConnectError(error: unknown): boolean {
  if (error instanceof HandshakeNotReadyError) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  if (isFatalAppIdError(message)) {
    return false
  }
  if (/no discord ipc socket/i.test(message)) {
    return false
  }
  if (/application id is invalid/i.test(message)) {
    return false
  }
  return (
    /handshake timed out/i.test(message) ||
    /handshake returned null data/i.test(message) ||
    /not fully initialized/i.test(message) ||
    /connection closed/i.test(message) ||
    /econnreset/i.test(message) ||
    /epipe/i.test(message)
  )
}
