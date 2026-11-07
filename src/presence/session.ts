/**
 * Session clock: when the current stretch of Orca activity began.
 *
 * Why: `touch` is the only thing that moves the clock, so idle time never
 * extends a session and the next activity after a gap starts a new one.
 *
 * @module presence/session
 * @author Jonathan Marien
 * @date 2026-11-06
 */

import { SESSION_GAP_MS } from './expiry'

/** Serializable session state (stored in plugin storage across worker restarts). */
export type SessionJSON = { startMs: number; lastActiveMs: number }

/** Construction options for {@link createSessionClock}. */
export type SessionClockOptions = {
  gapMs?: number
  now?: () => number
}

/** Mutable session clock used by the plugin worker. */
export type SessionClock = {
  /** Record activity; starts a new session when none exists or the gap passed. */
  touch: () => void
  startMs: () => number | undefined
  /** Load a stored {@link SessionJSON}; junk, future or stale values are ignored. */
  restore: (value: unknown) => void
  toJSON: () => SessionJSON | null
}

/**
 * Create a session clock with an injectable clock.
 *
 * @param options - Gap and clock overrides for tests.
 * @returns A {@link SessionClock}.
 */
export function createSessionClock({ gapMs = SESSION_GAP_MS, now = () => Date.now() }: SessionClockOptions = {}): SessionClock {
  let start: number | undefined
  let lastActive: number | undefined

  return {
    touch() {
      const current = now()
      if (start === undefined || lastActive === undefined || current - lastActive > gapMs) {
        start = current
      }
      lastActive = current
    },
    // Why: a lapsed session must not keep counting idle time on Discord.
    startMs: () => (start !== undefined && lastActive !== undefined && now() - lastActive > gapMs ? undefined : start),
    restore(value) {
      if (!value || typeof value !== 'object') {
        return
      }
      const { startMs, lastActiveMs } = value as { startMs?: unknown; lastActiveMs?: unknown }
      // Why: a corrupt or foreign storage value must never throw or seed a bogus timer.
      if (
        typeof startMs !== 'number' ||
        typeof lastActiveMs !== 'number' ||
        !Number.isFinite(startMs) ||
        !Number.isFinite(lastActiveMs)
      ) {
        return
      }
      const current = now()
      if (startMs > lastActiveMs || lastActiveMs > current || current - lastActiveMs > gapMs) {
        return
      }
      start = startMs
      lastActive = lastActiveMs
    },
    toJSON: () => (start === undefined || lastActive === undefined ? null : { startMs: start, lastActiveMs: lastActive })
  }
}
