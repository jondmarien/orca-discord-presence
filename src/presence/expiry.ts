/**
 * Activity expiry windows for future focus / tool providers.
 *
 * Burpcord expires sticky tool states (Proxy/WebSocket 30s; Scanner,
 * Repeater, Intruder 60s) so Discord does not keep showing a surface the
 * user already left. This plugin does **not** rotate providers yet —
 * presence is still agent status + workspace snapshot only. Wire
 * {@link isActivityFresh} when focused-window/tab providers land (#7).
 *
 * @module presence/expiry
 * @author Jonathan Marien
 * @date 2026-09-05
 */

/**
 * Named windows matching Burpcord's short vs long tool activity.
 *
 * @author Jonathan Marien
 */
export const ACTIVITY_EXPIRY_MS = {
  /** Proxy / WebSocket-style chatter. */
  short: 30_000,
  /** Scanner / Repeater / Intruder-style work. */
  long: 60_000
} as const

/**
 * One of {@link ACTIVITY_EXPIRY_MS}.
 *
 * @author Jonathan Marien
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
 * @author Jonathan Marien
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
