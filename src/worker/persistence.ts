/**
 * Worker state persistence & status bar publisher: restores and coalesces
 * `timeline` and `session` storage writes, and publishes diff-gated status bar
 * updates with rejection retry.
 *
 * @module worker/persistence
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { elapsedStartMs } from '../presence/activity'
import type { CanonicalAgentState } from '../presence/agent-state'
import type { PresenceStatus } from '../presence/controller'
import { SESSION_GAP_MS } from '../presence/expiry'
import { createSessionClock } from '../presence/session'
import type { PresenceSettings } from '../presence/settings'
import { renderStatusBar } from '../presence/status-bar'
import { createTimeline, type TimelineSlot, type TimelineState } from '../presence/timeline'
import type { Disposer, OrcaHost } from './host'

/** Plugin storage key for the persisted 30-minute strip. */
export const TIMELINE_STORAGE_KEY = 'timeline'

/** Plugin storage key for the persisted session clock. */
export const SESSION_STORAGE_KEY = 'session'

/** Coalescing window for routine storage saves. */
export const STATE_SAVE_INTERVAL_MS = 15_000

export type StatusBarPublishInput = {
  status: PresenceStatus
  settings: PresenceSettings
  agentState?: CanonicalAgentState
  agentCount: number
  stateStartedAtMs?: number
}

export type WorkerPersistence = {
  recordTimeline: (states: readonly TimelineState[]) => void
  timelineSlots: () => TimelineSlot[]
  sessionStartMs: () => number | undefined
  /** Touch session clock and schedule coalesced save; returns true if session start moved. */
  touchSession: () => boolean
  /** Touch session clock without scheduling (caller calls `scheduleSave`). */
  touchSessionOnly: () => void
  scheduleSave: () => void
  /** Cancel pending coalesced save and flush timeline + session to storage. */
  flush: () => Promise<void>
  publishStatusBar: (input: StatusBarPublishInput) => void
}

export async function createPersistence({
  host,
  disposer,
  now = () => Date.now(),
  saveIntervalMs = STATE_SAVE_INTERVAL_MS
}: {
  host: OrcaHost['host']
  disposer: Disposer
  now?: () => number
  saveIntervalMs?: number
}): Promise<WorkerPersistence> {
  // Why: restore the strip so worker restarts do not blank the last 30 minutes.
  const storedTimeline = host.has('storage.get')
    ? ((await host.call('storage.get', { key: TIMELINE_STORAGE_KEY }).catch(() => null)) as {
        value?: unknown
      } | null)
    : null
  const timeline = createTimeline({ now, restore: storedTimeline?.value })

  // Why: restoring keeps the session start across worker and Orca restarts inside the gap.
  const storedSession = host.has('storage.get')
    ? ((await host.call('storage.get', { key: SESSION_STORAGE_KEY }).catch(() => null)) as {
        value?: unknown
      } | null)
    : null
  const session = createSessionClock({ gapMs: SESSION_GAP_MS, now })
  session.restore(storedSession?.value)

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let lastStatusBar: string | null = null

  async function writeNow(): Promise<void> {
    if (!host.has('storage.set')) {
      return
    }
    const sessionState = session.toJSON()
    await Promise.all([
      host.call('storage.set', { key: TIMELINE_STORAGE_KEY, value: timeline.toJSON() }).catch(() => {}),
      sessionState
        ? host.call('storage.set', { key: SESSION_STORAGE_KEY, value: sessionState }).catch(() => {})
        : undefined
    ])
  }

  function scheduleSave() {
    if (saveTimer || !host.has('storage.set') || disposer.isDisposed()) {
      return
    }
    saveTimer = disposer.setTimeout(() => {
      saveTimer = null
      void writeNow()
    }, saveIntervalMs)
  }

  return {
    recordTimeline: (states) => timeline.record(states),
    timelineSlots: () => timeline.slots(),
    sessionStartMs: () => session.startMs(),
    touchSession() {
      const before = session.startMs()
      session.touch()
      scheduleSave()
      return session.startMs() !== before
    },
    touchSessionOnly() {
      session.touch()
    },
    scheduleSave,
    async flush() {
      disposer.clearTimeout(saveTimer)
      saveTimer = null
      await writeNow()
    },
    publishStatusBar({ status, settings, agentState, agentCount, stateStartedAtMs }) {
      if (!host.has('statusBar.update')) {
        return
      }
      const patch = renderStatusBar({
        status,
        settings,
        agentState,
        agentCount,
        elapsedStartMs: elapsedStartMs({ sessionStartMs: session.startMs(), stateStartedAtMs }, settings),
        nowMs: now()
      })
      const serialized = JSON.stringify(patch)
      if (serialized !== lastStatusBar) {
        lastStatusBar = serialized
        // Why: forget a rejected patch so the next identical one retries.
        void host.call('statusBar.update', patch).catch(() => {
          if (lastStatusBar === serialized) {
            lastStatusBar = null
          }
        })
      }
    }
  }
}
