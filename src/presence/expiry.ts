/**
 * Activity expiry windows for future focus / tool providers.
 *
 * Issue encountered in a prior Discord RPC integration: sticky tool states
 * (short ~30s chatter vs long ~60s work) need an expiry so Discord does
 * not keep showing a surface the user already left. Same idea applies
 * here when focused-window/tab providers land (#7). This plugin does
 * **not** rotate providers yet — presence is still agent status +
 * workspace snapshot only. Wire {@link isActivityFresh} then.
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
