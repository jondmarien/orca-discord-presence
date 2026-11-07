/**
 * Activity expiry windows for the agent table and future focus / tool
 * providers.
 *
 * {@link AGENT_RETENTION_MS} drops stale multi-agent slots (#15).
 * {@link ACTIVITY_EXPIRY_MS} (short ~30s / long ~60s) is the older
 * helper for when focused-window/tab providers land (#7). This plugin
 * does **not** rotate providers yet. Wire {@link isActivityFresh} then.
 *
 * @module presence/expiry
 * @author Jonathan Marien
 * @date 2026-09-05
 */

/**
 * Named windows: short (30s) vs long (60s) tool activity.
 */
export const ACTIVITY_EXPIRY_MS = {
  /** Short-lived chatter (a burst of small events). */
  short: 30_000,
  /** Longer-lived work (a focused session or scan). */
  long: 60_000
} as const

/**
 * In-memory agent-table retention (#15). Non-done rows go stale after
 * ~30 minutes without an update; `done` rows linger ~60 seconds then drop.
 */
export const AGENT_RETENTION_MS = {
  /** Last `receivedAt` age after which a non-done slot is dropped. */
  stale: 1_800_000,
  /**
   * How long a `done` (completed) slot stays listed. Why: the person should
   * still see which agent finished after glancing away; 10 minutes, then it
   * drops so presence falls back to idle.
   */
  done: 600_000,
  /** How long a slot whose state is unknown / idle stays before it is dropped. */
  idle: 60_000
} as const

/**
 * Idle gap (30 minutes) after which the next activity starts a new session.
 * Why: a long quiet stretch means the person left, so the session timer
 * should not keep counting across it.
 */
export const SESSION_GAP_MS = 1_800_000

/**
 * One of {@link ACTIVITY_EXPIRY_MS}.
 */
export type ActivityExpiryMs = (typeof ACTIVITY_EXPIRY_MS)[keyof typeof ACTIVITY_EXPIRY_MS]

/**
 * Whether `lastSeenAtMs` is still inside `windowMs` relative to `nowMs`.
 *
 * Invalid clocks or a non-positive window are treated as stale so a
 * misconfigured provider cannot pin presence forever.
 *
 * @param lastSeenAtMs - Host timestamp of the last qualifying event.
 * @param nowMs - Clock (usually `Date.now()`).
 * @param windowMs - Expiry window; see {@link ACTIVITY_EXPIRY_MS}.
 * @returns True only when the event is strictly inside the window.
 */
export function isActivityFresh(lastSeenAtMs: number, nowMs: number, windowMs: number): boolean {
  if (!Number.isFinite(lastSeenAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(windowMs)) {
    return false
  }
  if (windowMs <= 0) {
    return false
  }
  return nowMs - lastSeenAtMs < windowMs
}
