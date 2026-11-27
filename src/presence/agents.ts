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
  /** Workspace id from `workspace.list` (Host API 1.7+). */
  workspaceListId?: string
  paneKey: string
  terminalId?: string
  /** Agent session id from `agents.list` / `agent.status.changed` (Host API 1.8+). */
  sessionId?: string
  state: string
  receivedAt: number
  /**
   * When the agent entered `state`, if the host said so (`agents.list` or
   * `agent.status.changed.mainAgent.stateStartedAt`).
   *
   * Why: `receivedAt` drives retention, so a seeded row uses the listing time
   * there and keeps the true start here for the elapsed timer.
   */
  stateStartedAt?: number
  /** Agent CLI name from `agents.list` (`claude`, `codex`, ...). */
  kind?: string
  /**
   * Chat name from `agents.list` or `agent.status.changed`. Local panel only:
   * never copy it into the Discord activity, bridge payload or logs.
   */
  title?: string
  /**
   * Dispatched orchestration task title from `agents.list[].task.title`.
   * Local panel only: never copy it into Discord, bridge or logs.
   */
  taskTitle?: string
  /**
   * Main agent outcome (`success`, `failure`, `interruption`, ...) from
   * `agent.status.changed.mainAgent.outcome`. Panel hint only; never Discord.
   */
  outcome?: string
}

/**
 * Stored slot after canonicalize.
 */
export type AgentSlot = {
  workspaceId: string
  workspaceListId?: string
  paneKey: string
  terminalId?: string
  sessionId?: string
  rawState: string
  canonicalState: CanonicalAgentState
  receivedAt: number
  /** When the agent entered its current state; see {@link AgentStatusEvent.stateStartedAt}. */
  stateStartedAt?: number
  kind?: string
  /** Chat name; see {@link AgentStatusEvent.title}. Panel snapshot only. */
  title?: string
  /** Dispatched task title; panel snapshot only. */
  taskTitle?: string
  /** Main agent outcome; panel snapshot only. */
  outcome?: string
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
  removeWorkspace: (workspaceId: string | readonly string[]) => boolean
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
 * Slot key: `t:<terminalId>` when the terminal is known, else `s:<sessionId>`
 * when a session id is known, else `p:<workspaceId>\u001f<paneKey>`.
 *
 * Why: `agents.list` may return restored or unshown panes with `terminalId: null`
 * and a `sessionId`. Keying those as `s:<sessionId>` keeps them visible and lets
 * `upsert` reconcile them cleanly if a `terminalId` later arrives.
 */
export function agentSlotKey(
  event: Pick<AgentStatusEvent, 'workspaceId' | 'paneKey' | 'terminalId' | 'sessionId'>
): string {
  if (typeof event.terminalId === 'string' && event.terminalId.length > 0) {
    return `t:${event.terminalId}`
  }
  if (typeof event.sessionId === 'string' && event.sessionId.length > 0) {
    return `s:${event.sessionId}`
  }
  return `p:${event.workspaceId}\u001f${event.paneKey}`
}

/**
 * Parse a host `agent.status.changed` payload.
 *
 * Missing or null `workspaceId` / `paneKey` become `""`. Non-empty
 * `terminalId`, `workspaceListId`, `sessionId`, and `mainAgent` metadata are
 * kept. Missing `receivedAt` uses `nowMs`. A payload without a string `state`
 * is ignored.
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
  if (typeof source.workspaceListId === 'string' && source.workspaceListId.trim().length > 0) {
    event.workspaceListId = source.workspaceListId.trim()
  }
  if (typeof source.terminalId === 'string' && source.terminalId.length > 0) {
    event.terminalId = source.terminalId
  }
  if (typeof source.sessionId === 'string' && source.sessionId.trim().length > 0) {
    event.sessionId = source.sessionId.trim()
  }
  if (typeof source.title === 'string' && source.title.trim().length > 0) {
    event.title = source.title
  }
  if (source.mainAgent && typeof source.mainAgent === 'object') {
    const main = source.mainAgent as Record<string, unknown>
    if (typeof main.stateStartedAt === 'number' && Number.isFinite(main.stateStartedAt)) {
      event.stateStartedAt = main.stateStartedAt
    }
    if (typeof main.outcome === 'string' && main.outcome.trim().length > 0) {
      event.outcome = main.outcome.trim()
    }
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
 * All workspace identifiers (`workspaceId` and Host API 1.7 `workspaceListId`)
 * carried by a `workspace.removed` payload.
 */
export function parseWorkspaceRemovedIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return []
  }
  const source = payload as Record<string, unknown>
  const ids: string[] = []
  for (const raw of [source.workspaceId, source.workspaceListId]) {
    if (typeof raw === 'string' && raw.trim().length > 0 && !ids.includes(raw.trim())) {
      ids.push(raw.trim())
    }
  }
  return ids
}

/**
 * Map an `agents.list` result to events for seeding the table.
 *
 * Rows without a `terminalId` are kept when they carry a `sessionId` (keyed as
 * `s:<sessionId>`); rows with neither cannot be deduped and are dropped.
 *
 * @param result - Raw `agents.list` result, `{ agents: [...] }`.
 * @param nowMs - Listing time, used as `receivedAt` for active rows (finished
 *   rows use their `stateStartedAt`).
 * @param workspaceListId - Optional workspace id passed to `agents.list({ workspaceId })`.
 * @returns Events, or `[]` for any non-conforming input.
 */
export function parseAgentsList(
  result: unknown,
  nowMs: number,
  workspaceListId?: string
): AgentStatusEvent[] {
  if (!result || typeof result !== 'object') {
    return []
  }
  const rows = (result as Record<string, unknown>).agents
  if (!Array.isArray(rows)) {
    return []
  }
  const normalizedWorkspaceListId =
    typeof workspaceListId === 'string' && workspaceListId.trim().length > 0
      ? workspaceListId.trim()
      : undefined
  const events: AgentStatusEvent[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const source = row as Record<string, unknown>
    const terminalId =
      typeof source.terminalId === 'string' && source.terminalId.length > 0
        ? source.terminalId
        : undefined
    const sessionId =
      typeof source.sessionId === 'string' && source.sessionId.trim().length > 0
        ? source.sessionId.trim()
        : undefined
    if (!terminalId && !sessionId) {
      continue
    }
    if (typeof source.state !== 'string') {
      continue
    }
    const startedAt =
      typeof source.stateStartedAt === 'number' && Number.isFinite(source.stateStartedAt)
        ? source.stateStartedAt
        : undefined
    const canonical = canonicalizeAgentState(source.state)
    const finished = canonical === 'done' || canonical === 'idle'
    const event: AgentStatusEvent = {
      workspaceId: '',
      ...(normalizedWorkspaceListId ? { workspaceListId: normalizedWorkspaceListId } : {}),
      paneKey: '',
      ...(terminalId ? { terminalId } : {}),
      ...(sessionId ? { sessionId } : {}),
      state: source.state,
      // Why: the listing proves an active agent is alive now. Using its
      // (possibly hours old) start as `receivedAt` would drop it from the
      // stale window the moment the worker restarts. A finished row is the
      // opposite: retention counts from when it finished, so a long-done row
      // does not get a fresh window on every re-sync.
      receivedAt: finished ? (startedAt ?? nowMs) : nowMs
    }
    if (startedAt !== undefined) {
      event.stateStartedAt = startedAt
    }
    if (typeof source.agent === 'string' && source.agent.length > 0) {
      event.kind = source.agent
    }
    if (typeof source.title === 'string' && source.title.trim().length > 0) {
      event.title = source.title
    }
    if (source.task && typeof source.task === 'object') {
      const taskTitle = (source.task as Record<string, unknown>).title
      if (typeof taskTitle === 'string' && taskTitle.trim().length > 0) {
        event.taskTitle = taskTitle.trim()
      }
    }
    events.push(event)
  }
  return events
}

function retentionWindow(state: CanonicalAgentState): number {
  // Why: an idle agent is not running work, so it lingers only as long as `done`.
  if (state === 'done') return AGENT_RETENTION_MS.done
  return state === 'idle' ? AGENT_RETENTION_MS.idle : AGENT_RETENTION_MS.stale
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
    const since = slot.stateStartedAt ?? slot.receivedAt
    if (slot.canonicalState === winner && since < started) {
      started = since
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
      let key = agentSlotKey(event)
      let previous = map.get(key)
      // Why: a restored agent first seen by `sessionId` (`s:<id>`) may later
      // gain a `terminalId` (`t:<id>`), or a `t:<id>` row may receive a
      // session-only update. Reconcile under one key so it is never counted twice.
      if (event.terminalId && event.sessionId) {
        const sessionKey = `s:${event.sessionId}`
        const priorSession = map.get(sessionKey)
        if (priorSession) {
          previous = previous ?? priorSession
          map.delete(sessionKey)
        }
      } else if (!event.terminalId && event.sessionId) {
        for (const [existingKey, existingSlot] of map) {
          if (existingKey.startsWith('t:') && existingSlot.sessionId === event.sessionId) {
            key = existingKey
            previous = existingSlot
            break
          }
        }
      }
      // Why: `agent.status.changed` has no agent name, so a later event must
      // not erase the `kind` the seeded `agents.list` row supplied.
      const kind = event.kind ?? previous?.kind
      // Why: same for `title`, `taskTitle`, `sessionId`, and `workspaceListId`.
      const title = event.title ?? previous?.title
      const taskTitle = event.taskTitle ?? previous?.taskTitle
      const sessionId = event.sessionId ?? previous?.sessionId
      const terminalId = event.terminalId ?? previous?.terminalId
      // Why: `agents.list` rows have no workspace, so a re-sync must not wipe
      // the id a status event supplied or `removeWorkspace` would miss it.
      const workspaceId = event.workspaceId || previous?.workspaceId || ''
      const workspaceListId = event.workspaceListId || previous?.workspaceListId
      // Why: a newer start on a finished slot (`done` / `idle`) is a separate,
      // later completion; an active same-state agent (`working`/`waiting`/
      // `blocked`) keeps its first start so chatty tool events never reset its
      // timer or rebuild the panel's Agents list.
      const finished = canonicalState === 'done' || canonicalState === 'idle'
      const newerStart =
        finished &&
        event.stateStartedAt !== undefined &&
        previous?.stateStartedAt !== undefined &&
        event.stateStartedAt > previous.stateStartedAt
      const stateStartedAt =
        previous?.canonicalState === canonicalState && previous.stateStartedAt !== undefined && !newerStart
          ? previous.stateStartedAt
          : (event.stateStartedAt ?? event.receivedAt)
      // Why: a re-sync of an already finished slot must never extend its
      // retention; it keeps the receivedAt of the first sighting. A later
      // completion (newer start) gets its own schedule.
      const keepReceived = finished && previous?.canonicalState === canonicalState && !newerStart
      const receivedAt = keepReceived && previous ? previous.receivedAt : event.receivedAt
      // Why: outcome describes a finished run; clear it when work resumes.
      const outcome = finished ? (event.outcome ?? (previous?.canonicalState === canonicalState ? previous.outcome : undefined)) : undefined
      map.set(key, {
        workspaceId,
        ...(workspaceListId ? { workspaceListId } : {}),
        paneKey: event.paneKey || previous?.paneKey || '',
        ...(terminalId ? { terminalId } : {}),
        ...(sessionId ? { sessionId } : {}),
        rawState: event.state,
        canonicalState,
        receivedAt,
        stateStartedAt,
        ...(kind ? { kind } : {}),
        ...(title ? { title } : {}),
        ...(taskTitle ? { taskTitle } : {}),
        ...(outcome ? { outcome } : {})
      })
      prune()
      schedulePrune()
    },
    removeWorkspace(workspaceId) {
      const targets = new Set(Array.isArray(workspaceId) ? workspaceId : [workspaceId])
      let changed = false
      for (const [key, slot] of map) {
        if (
          (slot.workspaceId && targets.has(slot.workspaceId)) ||
          (slot.workspaceListId && targets.has(slot.workspaceListId))
        ) {
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
