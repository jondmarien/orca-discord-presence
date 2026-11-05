/**
 * In-memory multi-agent / multi-worktree presence table.
 *
 * Stock `agent.status.changed` carries `workspaceId`, `paneKey`, optional
 * `terminalId`, `state`, and `receivedAt`. `agents.list` seeds the same table
 * by terminal. This module aggregates those slots, drops stale and
 * recently-done rows, and produces one canonical state for
 * {@link buildActivity}.
 *
 * @module presence/agents
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { canonicalizeAgentState, type CanonicalAgentState } from './agent-state'
import { AGENT_RETENTION_MS, isActivityFresh } from './expiry'

/**
 * One parsed `agent.status.changed` event.
 */
export type AgentStatusEvent = {
  workspaceId: string
  paneKey: string
  terminalId?: string
  state: string
  receivedAt: number
  /** Agent CLI name from `agents.list` (`claude`, `codex`, ...). */
  kind?: string
}

/**
 * Stored slot after canonicalize.
 */
export type AgentSlot = {
  workspaceId: string
  paneKey: string
  terminalId?: string
  rawState: string
  canonicalState: CanonicalAgentState
  receivedAt: number
  kind?: string
}

/**
 * Privacy-safe summary fed into the activity snapshot.
 */
export type AgentSummary = {
  agentCount: number
  agentState: CanonicalAgentState | undefined
  stateStartedAtMs: number | undefined
}

/**
 * Construction options for {@link createAgentTable}.
 */
export type AgentTableOptions = {
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  /** Called after a scheduled prune removes at least one slot. */
  onChange?: () => void
}

/**
 * Mutable agent table used by the plugin worker.
 */
export type AgentTable = {
  upsert: (event: AgentStatusEvent) => void
  removeWorkspace: (workspaceId: string) => boolean
  prune: () => boolean
  summarize: () => AgentSummary
  slots: () => AgentSlot[]
  clear: () => void
}

const PRIORITY: Record<CanonicalAgentState, number> = {
  blocked: 4,
  waiting: 3,
  working: 2,
  done: 1,
  idle: 0
}

/**
 * Slot key: `t:<terminalId>` when the terminal is known, else
 * `p:<workspaceId>\u001f<paneKey>`.
 *
 * Why: `agents.list` only knows terminals while `agent.status.changed` also
 * knows the pane. Keying by terminal makes a seeded row and its later event
 * the same slot, so one agent is never counted twice. Empty strings in the
 * pane fallback stay a valid single anonymous slot.
 */
export function agentSlotKey(
  event: Pick<AgentStatusEvent, 'workspaceId' | 'paneKey' | 'terminalId'>
): string {
  if (typeof event.terminalId === 'string' && event.terminalId.length > 0) {
    return `t:${event.terminalId}`
  }
  return `p:${event.workspaceId}\u001f${event.paneKey}`
}

/**
 * Parse a host `agent.status.changed` payload.
 *
 * Missing or null `workspaceId` / `paneKey` become `""`. A non-empty string
 * `terminalId` is kept. Missing `receivedAt` uses
 * `nowMs`. A payload without a string `state` is ignored.
 *
 * @param payload - Event body from the host.
 * @param nowMs - Clock used when `receivedAt` is absent.
 * @returns A normalized event, or `null`.
 */
export function parseAgentStatusPayload(payload: unknown, nowMs: number): AgentStatusEvent | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const source = payload as Record<string, unknown>
  if (typeof source.state !== 'string') {
    return null
  }
  const receivedAt =
    typeof source.receivedAt === 'number' && Number.isFinite(source.receivedAt)
      ? source.receivedAt
      : nowMs
  const event: AgentStatusEvent = {
    workspaceId: typeof source.workspaceId === 'string' ? source.workspaceId : '',
    paneKey: typeof source.paneKey === 'string' ? source.paneKey : '',
    state: source.state,
    receivedAt
  }
  if (typeof source.terminalId === 'string' && source.terminalId.length > 0) {
    event.terminalId = source.terminalId
  }
  return event
}

/**
 * Workspace id from a stock `workspace.removed` payload.
 */
export function parseWorkspaceRemovedId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const id = (payload as Record<string, unknown>).workspaceId
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null
}

/**
 * Map an `agents.list` result to events for seeding the table.
 *
 * Why: the list has no workspace or pane, so seeded rows use `""` for both and
 * adopt the real `workspaceId` when a later event for the same terminal
 * replaces them. Rows without a `terminalId` cannot be deduped and are dropped.
 *
 * @param result - Raw `agents.list` result, `{ agents: [...] }`.
 * @param nowMs - Fallback when a row has no numeric `stateStartedAt`.
 * @returns Events, or `[]` for any non-conforming input.
 */
export function parseAgentsList(result: unknown, nowMs: number): AgentStatusEvent[] {
  if (!result || typeof result !== 'object') {
    return []
  }
  const rows = (result as Record<string, unknown>).agents
  if (!Array.isArray(rows)) {
    return []
  }
  const events: AgentStatusEvent[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const source = row as Record<string, unknown>
    if (typeof source.terminalId !== 'string' || source.terminalId.length === 0) {
      continue
    }
    if (typeof source.state !== 'string') {
      continue
    }
    const event: AgentStatusEvent = {
      workspaceId: '',
      paneKey: '',
      terminalId: source.terminalId,
      state: source.state,
      receivedAt:
        typeof source.stateStartedAt === 'number' && Number.isFinite(source.stateStartedAt)
          ? source.stateStartedAt
          : nowMs
    }
    if (typeof source.agent === 'string' && source.agent.length > 0) {
      event.kind = source.agent
    }
    events.push(event)
  }
  return events
}

function retentionWindow(state: CanonicalAgentState): number {
  // Why: an idle agent is not running work, so it lingers only as long as `done`.
  return state === 'done' || state === 'idle' ? AGENT_RETENTION_MS.done : AGENT_RETENTION_MS.stale
}

/**
 * True when the slot is still inside its retention window.
 */
export function isAgentSlotFresh(slot: AgentSlot, nowMs: number): boolean {
  return isActivityFresh(slot.receivedAt, nowMs, retentionWindow(slot.canonicalState))
}

function summarizeSlots(slots: readonly AgentSlot[]): AgentSummary {
  if (slots.length === 0) {
    return { agentCount: 0, agentState: undefined, stateStartedAtMs: undefined }
  }
  let winner: CanonicalAgentState = 'idle'
  let winnerPriority = -1
  for (const slot of slots) {
    const priority = PRIORITY[slot.canonicalState]
    if (priority > winnerPriority) {
      winner = slot.canonicalState
      winnerPriority = priority
    }
  }
  let started = Number.POSITIVE_INFINITY
  for (const slot of slots) {
    if (slot.canonicalState === winner && slot.receivedAt < started) {
      started = slot.receivedAt
    }
  }
  return {
    agentCount: slots.length,
    agentState: winner,
    stateStartedAtMs: Number.isFinite(started) ? started : undefined
  }
}

/**
 * Create an agent table with injectable clock / timers.
 *
 * @param options - Clock, timer, and change hooks.
 * @returns A {@link AgentTable}.
 */
export function createAgentTable({
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  onChange
}: AgentTableOptions = {}): AgentTable {
  const map = new Map<string, AgentSlot>()
  let pendingTimer: unknown = null

  function cancelTimer() {
    if (pendingTimer) {
      clearTimer(pendingTimer)
      pendingTimer = null
    }
  }

  function schedulePrune() {
    cancelTimer()
    let nextAt = Number.POSITIVE_INFINITY
    const clock = now()
    for (const slot of map.values()) {
      const expiresAt = slot.receivedAt + retentionWindow(slot.canonicalState)
      if (expiresAt < nextAt) {
        nextAt = expiresAt
      }
    }
    if (!Number.isFinite(nextAt)) {
      return
    }
    pendingTimer = setTimer(() => {
      pendingTimer = null
      const changed = prune()
      if (changed) {
        onChange?.()
      }
      schedulePrune()
    }, Math.max(0, nextAt - clock))
  }

  function prune(): boolean {
    const clock = now()
    let changed = false
    for (const [key, slot] of map) {
      if (!isAgentSlotFresh(slot, clock)) {
        map.delete(key)
        changed = true
      }
    }
    return changed
  }

  return {
    upsert(event) {
      const canonicalState = canonicalizeAgentState(event.state)
      const key = agentSlotKey(event)
      // Why: `agent.status.changed` has no agent name, so a later event must
      // not erase the `kind` the seeded `agents.list` row supplied.
      const kind = event.kind ?? map.get(key)?.kind
      map.set(key, {
        workspaceId: event.workspaceId,
        paneKey: event.paneKey,
        ...(event.terminalId ? { terminalId: event.terminalId } : {}),
        rawState: event.state,
        canonicalState,
        receivedAt: event.receivedAt,
        ...(kind ? { kind } : {})
      })
      prune()
      schedulePrune()
    },
    removeWorkspace(workspaceId) {
      let changed = false
      for (const [key, slot] of map) {
        if (slot.workspaceId === workspaceId) {
          map.delete(key)
          changed = true
        }
      }
      if (changed) {
        schedulePrune()
      }
      return changed
    },
    prune,
    summarize() {
      prune()
      return summarizeSlots([...map.values()])
    },
    slots: () => [...map.values()],
    clear() {
      map.clear()
      cancelTimer()
    }
  }
}
