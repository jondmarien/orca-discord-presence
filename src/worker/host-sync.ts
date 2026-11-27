/**
 * Cross-workspace host synchronization and throttled session-metrics cache.
 *
 * Owns `workspace.list({ includeStatus: true })`, bounded `agents.list({ workspaceId })`
 * fan-out, evicting terminal kind-lookup tracking, and a unified TTL +
 * in-flight-deduped `agent.listSessions` cache shared by Discord session stats
 * and the panel Leaderboards card.
 *
 * @module worker/host-sync
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import os from 'node:os'
import type { CanonicalAgentState } from '../presence/agent-state'
import { parseAgentsList, parseAgentStatusPayload, parseWorkspaceRemovedIds, type AgentTable } from '../presence/agents'
import {
  parseSessionsList,
  parseWorkspaceList,
  resolveActiveSessionStats,
  type SessionMetrics,
  type WorkspaceHostKind,
  type WorkspaceInfo
} from '../presence/leaderboards'
import type { DiagnosticSink } from '../presence/log'
import type { PresenceSettings } from '../presence/settings'
import { timelineStateFor } from '../presence/timeline'
import type { RefreshFn } from './commands'
import type { DiscordBinding } from './discord-binding'
import type { Disposer, OrcaHost, WorkspaceContext } from './host'
import type { PanelRpc } from './panel-rpc'
import type { WorkerPersistence } from './persistence'
import type { SettingsRuntime } from './settings-runtime'

/** Minimum gap between `workspace.list` metadata refreshes on routine events. */
export const WORKSPACE_LIST_MIN_INTERVAL_MS = 5_000

/** Cap per-workspace `agents.list({ workspaceId })` fan-out to avoid rate limits. */
export const MAX_WORKSPACE_AGENT_FANOUT = 20

/**
 * Minimum gap between `agent.listSessions` history polls when session stats or
 * Leaderboards are enabled. Never called when both are off.
 */
export const SESSIONS_MIN_INTERVAL_MS = 30_000

/** Maximum sessions requested from `agent.listSessions`. */
export const SESSIONS_LIST_LIMIT = 200

/** Maximum retries to resolve an agent's CLI `kind` from `agents.list`. */
export const KIND_LOOKUP_ATTEMPTS = 5

export type HostSync = {
  syncWorkspaces: (force?: boolean) => Promise<WorkspaceInfo[]>
  syncSessionsIfNeeded: (settings: PresenceSettings, force?: boolean) => Promise<void>
  syncAgentsFromList: (options?: { workspaceId?: string; allWorkspaces?: boolean }) => Promise<void>
  /** Retry `agents.list` up to KIND_LOOKUP_ATTEMPTS times for terminals with unknown kind. */
  ensureAgentKind: (terminalId: string | undefined, workspaceListId?: string) => Promise<void>
  /** Evict terminal IDs from kind caches once they are no longer in `agentTable`. */
  pruneKindCache: () => void
  removeWorkspaces: (ids: readonly string[]) => void
  resolveFocusedWorkspace: (wsId: string | undefined) => Promise<WorkspaceInfo | undefined>
  setFocusedWorkspaceId: (wsId: string | undefined) => void
  focusedHostKind: () => WorkspaceHostKind | undefined
  workspaces: () => ReadonlyMap<string, WorkspaceInfo>
  sessions: () => readonly SessionMetrics[]
  clear: () => void
}

export function createHostSync({
  host,
  agentTable,
  disposer,
  diagnostics,
  now = () => Date.now(),
  workspaceListMinIntervalMs = WORKSPACE_LIST_MIN_INTERVAL_MS,
  sessionsMinIntervalMs = SESSIONS_MIN_INTERVAL_MS
}: {
  host: OrcaHost['host']
  agentTable: AgentTable
  disposer: Disposer
  diagnostics?: DiagnosticSink
  now?: () => number
  workspaceListMinIntervalMs?: number
  sessionsMinIntervalMs?: number
}): HostSync {
  let workspacesById = new Map<string, WorkspaceInfo>()
  let sessionsCache: SessionMetrics[] = []
  let focusedWorkspaceId: string | undefined
  let focusedHostKind: WorkspaceHostKind | undefined
  let lastWorkspaceListAt = 0
  let lastSessionsAt = 0
  let inFlightSessions: Promise<void> | null = null

  const kindAttempts = new Map<string, number>()
  const kindKnown = new Set<string>()

  function pruneKindCache() {
    if (kindAttempts.size === 0 && kindKnown.size === 0) {
      return
    }
    const activeTerminals = new Set<string>()
    for (const slot of agentTable.slots()) {
      if (slot.terminalId) {
        activeTerminals.add(slot.terminalId)
      }
    }
    for (const id of kindAttempts.keys()) {
      if (!activeTerminals.has(id)) {
        kindAttempts.delete(id)
      }
    }
    for (const id of kindKnown) {
      if (!activeTerminals.has(id)) {
        kindKnown.delete(id)
      }
    }
  }

  function recordListedAgents(listed: unknown, workspaceListId?: string) {
    for (const seeded of parseAgentsList(listed, now(), workspaceListId)) {
      if (seeded.terminalId && seeded.kind) {
        kindKnown.add(seeded.terminalId)
        kindAttempts.delete(seeded.terminalId)
      }
      agentTable.upsert(seeded)
    }
    pruneKindCache()
  }

  async function syncWorkspaces(force = false): Promise<WorkspaceInfo[]> {
    if (!host.has('workspace.list')) {
      return [...workspacesById.values()]
    }
    const clock = now()
    if (!force && lastWorkspaceListAt > 0 && clock - lastWorkspaceListAt < workspaceListMinIntervalMs) {
      return [...workspacesById.values()]
    }
    lastWorkspaceListAt = clock
    const listed = await host.call('workspace.list', { includeStatus: true }).catch(() => null)
    if (disposer.isDisposed() || !listed) {
      return [...workspacesById.values()]
    }
    const rows = parseWorkspaceList(listed)
    const next = new Map<string, WorkspaceInfo>()
    for (const row of rows) {
      next.set(row.id, row)
    }
    workspacesById = next
    return rows
  }

  async function syncSessionsIfNeeded(settings: PresenceSettings, force = false): Promise<void> {
    if (settings.showSessionStats === 'off' && !settings.showLeaderboards) {
      return
    }
    if (!host.has('agent.listSessions')) {
      return
    }
    const clock = now()
    if (!force && lastSessionsAt > 0 && clock - lastSessionsAt < sessionsMinIntervalMs) {
      return
    }
    if (inFlightSessions) {
      await inFlightSessions
      return
    }
    lastSessionsAt = clock
    const fetchPromise = (async () => {
      const listed = await host
        .call('agent.listSessions', { limit: SESSIONS_LIST_LIMIT })
        .catch(() => null)
      if (disposer.isDisposed() || !listed) {
        return
      }
      // Why: parseSessionsList discards `session.title` immediately so titles never enter memory.
      sessionsCache = parseSessionsList(listed)
      let running = 0
      let withTokens = 0
      let withMessages = 0
      for (const s of sessionsCache) {
        if (s.running) running += 1
        if (s.totalTokens > 0) withTokens += 1
        if (s.messageCount > 0) withMessages += 1
      }
      diagnostics?.line('debug', 'sessions.sync', {
        count: sessionsCache.length,
        running,
        withTokens,
        withMessages
      })
    })().finally(() => {
      if (inFlightSessions === fetchPromise) {
        inFlightSessions = null
      }
    })
    inFlightSessions = fetchPromise
    await fetchPromise
  }

  async function syncAgentsFromList(options: { workspaceId?: string; allWorkspaces?: boolean } = {}) {
    if (!host.has('agents.list')) {
      return
    }
    if (options.workspaceId) {
      const listed = await host
        .call('agents.list', { workspaceId: options.workspaceId })
        .catch(() => null)
      recordListedAgents(listed, options.workspaceId)
      return
    }
    if (options.allWorkspaces && host.has('workspace.list')) {
      const workspaces = await syncWorkspaces(true)
      const active = workspaces
        .filter((ws) => ws.statusState !== 'inactive' || ws.terminalCount > 0)
        .slice(0, MAX_WORKSPACE_AGENT_FANOUT)
      if (active.length > 0) {
        let queried = 0
        for (const ws of active) {
          if (disposer.isDisposed()) {
            return
          }
          try {
            const listed = await host.call('agents.list', { workspaceId: ws.id })
            recordListedAgents(listed, ws.id)
            queried += 1
          } catch (error) {
            const code = (error as { code?: unknown } | null)?.code
            if (code === 'rate_limited') {
              diagnostics?.line('warn', 'agents.list_rate_limited', { queried, total: active.length })
              break
            }
          }
        }
        if (queried > 0) {
          return
        }
      }
    }
    const listed = await host.call('agents.list').catch(() => null)
    recordListedAgents(listed, focusedWorkspaceId)
  }

  return {
    syncWorkspaces,
    syncSessionsIfNeeded,
    syncAgentsFromList,
    async ensureAgentKind(terminalId, workspaceListId) {
      if (!terminalId || kindKnown.has(terminalId)) {
        return
      }
      const attempts = kindAttempts.get(terminalId) ?? 0
      if (attempts < KIND_LOOKUP_ATTEMPTS) {
        kindAttempts.set(terminalId, attempts + 1)
        await syncAgentsFromList(workspaceListId ? { workspaceId: workspaceListId } : {})
      }
    },
    pruneKindCache,
    removeWorkspaces(ids) {
      for (const id of ids) {
        workspacesById.delete(id)
      }
      pruneKindCache()
    },
    async resolveFocusedWorkspace(wsId) {
      focusedWorkspaceId = wsId
      if (wsId && !workspacesById.has(wsId)) {
        await syncWorkspaces(false)
      }
      const info = wsId ? workspacesById.get(wsId) : undefined
      focusedHostKind = info?.hostKind
      return info
    },
    setFocusedWorkspaceId(wsId) {
      if (wsId) {
        focusedWorkspaceId = wsId
      }
    },
    focusedHostKind: () => focusedHostKind,
    workspaces: () => workspacesById,
    sessions: () => sessionsCache,
    clear() {
      workspacesById.clear()
      sessionsCache = []
      focusedWorkspaceId = undefined
      focusedHostKind = undefined
      kindAttempts.clear()
      kindKnown.clear()
      inFlightSessions = null
    }
  }
}

/** Wire host events to the shared refresh path. */
export function registerHostEvents(
  orca: OrcaHost,
  agentTable: AgentTable,
  hostSync: HostSync,
  refresh: RefreshFn
): void {
  orca.events.on('agent.status.changed', async (payload) => {
    const parsed = parseAgentStatusPayload(payload, Date.now())
    await hostSync.ensureAgentKind(parsed?.terminalId, parsed?.workspaceListId)
    await refresh(parsed ?? undefined)
  })
  orca.events.on('workspace.removed', async (payload) => {
    const removedIds = parseWorkspaceRemovedIds(payload)
    if (removedIds.length > 0) {
      agentTable.removeWorkspace(removedIds)
      hostSync.removeWorkspaces(removedIds)
    }
    await refresh()
  })
  orca.events.on('workspace.changed', async (payload) => {
    const raw = (payload as { context?: unknown } | null | undefined)?.context
    const context = raw && typeof raw === 'object' ? (raw as WorkspaceContext) : null
    hostSync.setFocusedWorkspaceId(context?.workspaceId)
    await hostSync.syncAgentsFromList(context?.workspaceId ? { workspaceId: context.workspaceId } : {})
    await refresh(undefined, { context })
  })
}

/** Seed active workspaces without consuming the host's 10s activation window. */
export async function seedHostState(hostSync: HostSync, settings: PresenceSettings): Promise<void> {
  const seed = Promise.all([
    hostSync.syncAgentsFromList({ allWorkspaces: true }),
    hostSync.syncSessionsIfNeeded(settings, true)
  ]).catch(() => {})
  let timer: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    seed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_500)
      timer.unref?.()
    })
  ])
  if (timer) clearTimeout(timer)
}

export type LatestAgentSummary = {
  agentState: CanonicalAgentState | undefined
  agentCount: number
  stateStartedAtMs?: number
}

/**
 * Create the unified refresh runner that merges agent events, workspace context,
 * and session stats into the presence controller, timeline, status bar, and panel.
 */
export function createRefreshRunner({
  orca,
  agentTable,
  hostSync,
  settingsRuntime,
  persistence,
  binding,
  panelRpc,
  diagnostics,
  onSummary,
  publishStatusBar
}: {
  orca: OrcaHost
  agentTable: AgentTable
  hostSync: HostSync
  settingsRuntime: SettingsRuntime
  persistence: WorkerPersistence
  binding: DiscordBinding
  panelRpc: PanelRpc
  diagnostics: DiagnosticSink
  onSummary: (summary: LatestAgentSummary) => void
  publishStatusBar: () => void
}): RefreshFn {
  return async (agentEvent, options = {}) => {
    if (agentEvent) {
      const parsed = parseAgentStatusPayload(agentEvent, Date.now())
      if (parsed) agentTable.upsert(parsed)
    }
    const summary = agentTable.summarize()
    onSummary(summary)
    // Why: `workspace.changed` already carries the context (possibly null for
    // "nothing focused"), so use it instead of a second host round trip.
    const context =
      options.context !== undefined
        ? options.context
        : ((await orca.host.call('workspace.readContext').catch(() => null)) as WorkspaceContext | null)
    const wsId =
      typeof context?.workspaceId === 'string' && context.workspaceId.length > 0 ? context.workspaceId : undefined
    const wsInfo = await hostSync.resolveFocusedWorkspace(wsId)
    const currentSettings = settingsRuntime.current()
    await hostSync.syncSessionsIfNeeded(currentSettings, false)
    const slots = agentTable.slots()
    const activeStats =
      currentSettings.showSessionStats !== 'off'
        ? resolveActiveSessionStats(slots, hostSync.sessions(), wsId)
        : undefined
    if (!context) {
      diagnostics.line('debug', 'refresh.minimal', { reason: 'no workspace context', agents: summary.agentCount })
    } else if (agentEvent) {
      diagnostics.line('debug', 'refresh', {
        source: 'agent.status.changed',
        agentState: summary.agentState ?? 'idle',
        agents: summary.agentCount
      })
    }
    // Why: only real activity extends a session; the bare heartbeat must not, or an
    // idle Orca would never end its session. Startup with an open workspace counts.
    if (agentEvent || options.context !== undefined || summary.agentCount > 0 || (options.startup && context)) {
      persistence.touchSessionOnly()
    }
    const resume = Boolean(options.resume || agentEvent)
    await binding.controller().update(
      {
        machineName: os.hostname(),
        ...(context
          ? {
              displayName: context.displayName,
              projectName: wsInfo?.project,
              branch: context.branch,
              terminalCount: Array.isArray(context.terminals) ? context.terminals.length : undefined
            }
          : // Why: the controller merges snapshots, so omitted keys would keep the
            // previous workspace on Discord after focus moves to nothing.
            { displayName: undefined, projectName: undefined, branch: undefined, terminalCount: undefined }),
        agentState: summary.agentState,
        stateStartedAtMs: summary.stateStartedAtMs,
        sessionStartMs: persistence.sessionStartMs(),
        agentCount: summary.agentCount,
        sessionTokens: activeStats?.tokens,
        sessionMessages: activeStats?.messages
      },
      resume ? { resume: true } : undefined
    )
    if (options.force) {
      await binding.controller().forceTransmit(resume)
    }
    persistence.recordTimeline(slots.map((slot) => timelineStateFor(slot.canonicalState)))
    persistence.scheduleSave()
    publishStatusBar()
    panelRpc.publish('debounced')
  }
}
