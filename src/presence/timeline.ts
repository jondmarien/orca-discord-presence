/**
 * Rolling 30-minute agent-state timeline for the panel.
 *
 * Each minute holds every state recorded in it, strongest first
 * (`blocked > waiting > working > completed > idle`). The worker records the
 * set of all agents' states on every refresh; the panel draws `slots()` as a
 * strip, one stacked segment per state.
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

/**
 * States the timeline can hold. Orca's `done` is recorded as `completed`;
 * `idle` means nothing was running (no agents).
 */
export type TimelineState = 'working' | 'waiting' | 'blocked' | 'completed' | 'idle'

/**
 * One minute: every state present, strongest first (`idle` only when it is
 * the only one), or `null` for no data.
 */
export type TimelineSlot = TimelineState[] | null

/** Number of minute slots returned by {@link Timeline.slots}. */
export const TIMELINE_MINUTES = 30

const MINUTE_MS = 60_000

const PRIORITY: Record<TimelineState, number> = {
  blocked: 4,
  waiting: 3,
  working: 2,
  completed: 1,
  idle: 0
}

/**
 * Map an agent summary state to the timeline state to record.
 *
 * Why: the agent table keeps Orca's canonical name `done`, while the panel
 * shows it as `completed`; no agents at all is `idle`. Keeping the mapping in
 * one place stops the worker and the panel disagreeing.
 *
 * @param agentState - `AgentSummary.agentState`, or undefined with no agents.
 * @returns The {@link TimelineState} to record.
 */
export function timelineStateFor(agentState: string | undefined): TimelineState {
  return agentState === undefined ? 'idle' : agentState === 'done' ? 'completed' : (agentState as TimelineState)
}

/** Construction options for {@link createTimeline}. */
export type TimelineOptions = {
  now?: () => number
  /** Restore a {@link TimelineDump}; junk entries are ignored. */
  restore?: unknown
}

/** Mutable timeline used by the plugin worker. */
export type Timeline = {
  /** Record every agent's state at this refresh; `[]` means no agents (idle). */
  record: (states: readonly TimelineState[]) => void
  slots: () => TimelineSlot[]
  /** Minute buckets for persistence: `[minute, seen, latest][]` plus the first minute seen. */
  toJSON: () => TimelineDump
}

/** Serializable timeline state (stored in plugin storage across worker restarts). */
export type TimelineDump = {
  first: number | null
  buckets: [number, TimelineState[], TimelineState[]][]
}

const TIMELINE_STATES: ReadonlySet<string> = new Set(['working', 'waiting', 'blocked', 'completed', 'idle'])

/**
 * Order a set of states strongest first, dropping duplicates. `idle` only
 * survives when nothing else is present; an empty set is `idle`.
 */
function orderStates(states: Iterable<TimelineState>): TimelineState[] {
  const unique = [...new Set(states)].sort((a, b) => PRIORITY[b] - PRIORITY[a])
  const active = unique.filter((state) => state !== 'idle')
  return active.length > 0 ? active : ['idle']
}

/**
 * Coerce a dump entry (new list, or the old single-state string) to a list.
 */
function toStateList(value: unknown): TimelineState[] | null {
  const items = Array.isArray(value) ? value : [value]
  const states = items.filter(isState)
  return states.length > 0 ? orderStates(states) : null
}

/**
 * Create a timeline with an injectable clock.
 *
 * @param options - Clock override for tests.
 * @returns A {@link Timeline}.
 */
export function createTimeline({ now = () => Date.now(), restore }: TimelineOptions = {}): Timeline {
  // Why: each minute keeps every state seen (what the cell shows) and the
  // latest set (what carries into later minutes with no events). Carrying the
  // union would keep a minute that ended in `completed` painted `working`
  // until the next event.
  const buckets = new Map<number, { seen: TimelineState[]; last: TimelineState[] }>()
  let firstMinute: number | null = null
  // Why: the worker restarts (dev reloads, idle reaping, Orca restarts); without
  // this the strip would go blank each time.
  if (restore && typeof restore === 'object') {
    const dump = restore as { first?: unknown; buckets?: unknown }
    if (typeof dump.first === 'number' && Number.isFinite(dump.first)) {
      firstMinute = dump.first
    }
    if (Array.isArray(dump.buckets)) {
      for (const entry of dump.buckets) {
        // Why: older dumps hold `[minute, top]` or `[minute, top, last]` with
        // bare strings; both still load, a lone string being a one-state list.
        const seen = Array.isArray(entry) && typeof entry[0] === 'number' ? toStateList(entry[1]) : null
        if (!Array.isArray(entry) || !seen) {
          continue
        }
        buckets.set(entry[0], { seen, last: toStateList(entry[2]) ?? seen })
      }
    }
  }

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
    record(states) {
      const minute = Math.floor(now() / MINUTE_MS)
      if (firstMinute === null) {
        firstMinute = minute
      }
      const latest = orderStates(states)
      const existing = buckets.get(minute)
      buckets.set(minute, {
        seen: orderStates([...(existing?.seen ?? []), ...latest]),
        last: latest
      })
      prune(minute)
    },
    slots() {
      const current = Math.floor(now() / MINUTE_MS)
      const start = current - TIMELINE_MINUTES + 1
      let carried: TimelineState[] | null = null
      let seedMinute = -Infinity
      for (const [minute, bucket] of buckets) {
        if (minute < start && minute > seedMinute) {
          seedMinute = minute
          carried = bucket.last
        }
      }
      const out: TimelineSlot[] = []
      for (let minute = start; minute <= current; minute += 1) {
        const own = buckets.get(minute)
        if (firstMinute === null || minute < firstMinute) {
          out.push(null)
          continue
        }
        if (own) {
          out.push([...own.seen])
          carried = own.last
        } else {
          out.push(carried ? [...carried] : null)
        }
      }
      return out
    },
    toJSON() {
      return {
        first: firstMinute,
        buckets: [...buckets.entries()].map(([minute, bucket]) => [minute, [...bucket.seen], [...bucket.last]])
      }
    }
  }
}

function isState(value: unknown): value is TimelineState {
  return typeof value === 'string' && TIMELINE_STATES.has(value)
}
