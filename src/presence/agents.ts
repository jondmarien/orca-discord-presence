/**
 * In-memory multi-agent / multi-worktree presence table.
 *
 * `agent.status.changed` already carries `worktreeId`, `paneKey`, `state`,
 * and `receivedAt`. This module aggregates those slots, drops stale and
 * recently-done rows, and produces one canonical state for
 * {@link buildActivity}. Optional focus join keys pick type/model/profile
 * without changing the global count or blocked/waiting aggregate.
 *
 * @module presence/agents
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { canonicalizeAgentState, type CanonicalAgentState } from './agent-state'
import { AGENT_RETENTION_MS, isActivityFresh } from './expiry'
import { parseAgentIdentity, type AgentIdentity } from './host-context'

/**
 * One parsed `agent.status.changed` event.
 */
export type AgentStatusEvent = {
  worktreeId: string
  paneKey: string
  state: string
  receivedAt: number
  /** Optional Orca-3 labels from the event payload. */
  agent?: AgentIdentity
}

/**
 * Stored slot after canonicalize.
 */
export type AgentSlot = {
  worktreeId: string
  paneKey: string
  rawState: string
  canonicalState: CanonicalAgentState
  receivedAt: number
  agent?: AgentIdentity
}

/**
 * Privacy-safe summary fed into the activity snapshot.
 */
export type AgentSummary = {
  agentCount: number
  agentState: CanonicalAgentState | undefined
  stateStartedAtMs: number | undefined
  agentType: string | undefined
  agentModel: string | undefined
  agentProfile: string | undefined
}

/**
 * Optional focus join keys from host #8. Used only to pick type/model/profile.
 * Count and canonical state stay global so a blocked agent on another
 * worktree still shows.
 */
export type AgentIdentityFocus = {
  worktreeId?: string | null
  agentId?: string | null
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
  removeWorktree: (worktreeId: string) => boolean
  prune: () => boolean
  summarize: (focus?: AgentIdentityFocus) => AgentSummary
  slots: () => AgentSlot[]
  clear: () => void
}

const PRIORITY: Record<CanonicalAgentState, number> = {
  blocked: 3,
  waiting: 2,
  working: 1,
  done: 0
}

/**
 * Slot key: worktree + pane. Empty strings are a valid single anonymous slot.
 */
export function agentSlotKey(worktreeId: string, paneKey: string): string {
  return `${worktreeId}\u001f${paneKey}`
}

/**
 * Host join rule: `paneKey` matches `agentId` exactly or as `${agentId}:…`.
 *
 * @param paneKey - Slot pane key from `agent.status.changed`.
 * @param agentId - Focused-surface agent-session id.
 */
export function paneKeyMatchesAgentId(paneKey: string, agentId: string): boolean {
  const pane = paneKey.trim()
  const id = agentId.trim()
  if (!id) {
    return false
  }
  return pane === id || pane.startsWith(`${id}:`)
}

/**
 * Parse a host `agent.status.changed` payload.
 *
 * Missing `worktreeId` / `paneKey` become `""`. Missing `receivedAt` uses
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
  const identity = parseAgentIdentity(source)
  const event: AgentStatusEvent = {
    worktreeId: typeof source.worktreeId === 'string' ? source.worktreeId : '',
    paneKey: typeof source.paneKey === 'string' ? source.paneKey : '',
    state: source.state,
    receivedAt
  }
  if (identity.type || identity.model || identity.profile) {
    event.agent = identity
  }
  return event
}

/**
 * Best-effort worktree id from `worktree.removed`.
 */
export function parseWorktreeRemovedId(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return payload.trim()
  }
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const source = payload as Record<string, unknown>
  if (typeof source.worktreeId === 'string' && source.worktreeId.trim().length > 0) {
    return source.worktreeId.trim()
  }
  if (typeof source.id === 'string' && source.id.trim().length > 0) {
    return source.id.trim()
  }
  return null
}

function retentionWindow(state: CanonicalAgentState): number {
  return state === 'done' ? AGENT_RETENTION_MS.done : AGENT_RETENTION_MS.stale
}

/**
 * True when the slot is still inside its retention window.
 */
export function isAgentSlotFresh(slot: AgentSlot, nowMs: number): boolean {
  return isActivityFresh(slot.receivedAt, nowMs, retentionWindow(slot.canonicalState))
}

function normalizeJoinKey(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * Slots matching optional focus join keys. An empty filter (no usable
 * keys, or no rows) is the caller's signal to fall back.
 */
export function filterSlotsByFocus(slots: readonly AgentSlot[], focus?: AgentIdentityFocus): AgentSlot[] {
  const worktreeId = normalizeJoinKey(focus?.worktreeId)
  const agentId = normalizeJoinKey(focus?.agentId)
  if (!worktreeId && !agentId) {
    return [...slots]
  }
  return slots.filter((slot) => {
    if (worktreeId && slot.worktreeId.trim() !== worktreeId) {
      return false
    }
    if (agentId && !paneKeyMatchesAgentId(slot.paneKey, agentId)) {
      return false
    }
    return true
  })
}

function pickIdentityWinner(slots: readonly AgentSlot[]): AgentSlot | undefined {
  let winnerSlot: AgentSlot | undefined
  let winnerPriority = -1
  for (const slot of slots) {
    const priority = PRIORITY[slot.canonicalState]
    if (priority > winnerPriority) {
      winnerPriority = priority
      winnerSlot = slot
    }
  }
  return winnerSlot
}

function summarizeSlots(slots: readonly AgentSlot[], focus?: AgentIdentityFocus): AgentSummary {
  if (slots.length === 0) {
    return {
      agentCount: 0,
      agentState: undefined,
      stateStartedAtMs: undefined,
      agentType: undefined,
      agentModel: undefined,
      agentProfile: undefined
    }
  }
  let winner: CanonicalAgentState = 'done'
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
  const filtered = filterSlotsByFocus(slots, focus)
  const identitySource = filtered.length > 0 ? filtered : slots
  const identitySlot = pickIdentityWinner(identitySource)
  return {
    agentCount: slots.length,
    agentState: winner,
    stateStartedAtMs: Number.isFinite(started) ? started : undefined,
    agentType: identitySlot?.agent?.type,
    agentModel: identitySlot?.agent?.model,
    agentProfile: identitySlot?.agent?.profile
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
      map.set(agentSlotKey(event.worktreeId, event.paneKey), {
        worktreeId: event.worktreeId,
        paneKey: event.paneKey,
        rawState: event.state,
        canonicalState,
        receivedAt: event.receivedAt,
        agent: event.agent
      })
      prune()
      schedulePrune()
    },
    removeWorktree(worktreeId) {
      let changed = false
      for (const [key, slot] of map) {
        if (slot.worktreeId === worktreeId) {
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
    summarize(focus) {
      prune()
      return summarizeSlots([...map.values()], focus)
    },
    slots: () => [...map.values()],
    clear() {
      map.clear()
      cancelTimer()
    }
  }
}
