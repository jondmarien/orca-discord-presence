/**
 * Rolling 30-minute agent-state timeline for the panel.
 *
 * Each minute holds the highest-priority state recorded in it
 * (`blocked > waiting > working > idle`). The worker records on every
 * refresh; the panel draws `slots()` as a strip.
 *
 * Why: a minute with no events carries the previous state forward, so a long
 * `working` stretch stays `working` instead of flickering to idle. Minutes
 * before the first record stay `null`, so a worker restart reads as "no data"
 * and never as idle.
 *
 * @module presence/timeline
 * @author Jonathan Marien
 * @date 2026-11-04
 */

/** States the timeline can hold. `done` is recorded as `idle`. */
export type TimelineState = 'working' | 'waiting' | 'blocked' | 'idle'

/** One minute: a state, or `null` for no data. */
export type TimelineSlot = TimelineState | null

/** Number of minute slots returned by {@link Timeline.slots}. */
export const TIMELINE_MINUTES = 30

const MINUTE_MS = 60_000

const PRIORITY: Record<TimelineState, number> = {
  blocked: 3,
  waiting: 2,
  working: 1,
  idle: 0
}

/** Construction options for {@link createTimeline}. */
export type TimelineOptions = {
  now?: () => number
}

/** Mutable timeline used by the plugin worker. */
export type Timeline = {
  record: (state: TimelineState) => void
  slots: () => TimelineSlot[]
}

/**
 * Create a timeline with an injectable clock.
 *
 * @param options - Clock override for tests.
 * @returns A {@link Timeline}.
 */
export function createTimeline({ now = () => Date.now() }: TimelineOptions = {}): Timeline {
  const buckets = new Map<number, TimelineState>()
  let firstMinute: number | null = null

  // Why: keep the newest bucket older than the window so its state can carry
  // into the oldest visible minute; drop everything before it.
  function prune(current: number) {
    const cutoff = current - TIMELINE_MINUTES
    let keep = -Infinity
    for (const minute of buckets.keys()) {
      if (minute <= cutoff && minute > keep) {
        keep = minute
      }
    }
    for (const minute of buckets.keys()) {
      if (minute < keep) {
        buckets.delete(minute)
      }
    }
  }

  return {
    record(state) {
      const minute = Math.floor(now() / MINUTE_MS)
      if (firstMinute === null) {
        firstMinute = minute
      }
      const existing = buckets.get(minute)
      if (existing === undefined || PRIORITY[state] > PRIORITY[existing]) {
        buckets.set(minute, state)
      }
      prune(minute)
    },
    slots() {
      const current = Math.floor(now() / MINUTE_MS)
      const out: TimelineSlot[] = []
      let carried: TimelineState | null = null
      // Why: seed the carry from the newest bucket older than the window so a
      // state that began before the window still fills its start.
      let seedMinute = -Infinity
      for (const [minute, state] of buckets) {
        if (minute <= current - TIMELINE_MINUTES && minute > seedMinute) {
          seedMinute = minute
          carried = state
        }
      }
      for (let minute = current - TIMELINE_MINUTES + 1; minute <= current; minute += 1) {
        const own = buckets.get(minute)
        if (own !== undefined) {
          carried = own
        }
        out.push(firstMinute !== null && minute >= firstMinute ? carried : null)
      }
      return out
    }
  }
}
