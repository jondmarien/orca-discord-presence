/**
 * Local session history metrics, workspace metadata cache, and panel
 * leaderboards built from `agent.listSessions` and `workspace.list`.
 *
 * Privacy hard rule: `session.title` and `workspace.path` are discarded
 * immediately upon parsing and are never stored, logged, snapshotted, or
 * transmitted anywhere.
 *
 * @module presence/leaderboards
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import type { AgentSlot } from './agents'

/**
 * Redacted summary of one `workspace.list` entry. `path` is never kept.
 */
export type WorkspaceInfo = {
  id: string
  name: string
  project?: string
  hostId: string | null
  hostKind: WorkspaceHostKind
  statusState?: string
  terminalCount: number
}

/**
 * Coarse host location badge shown in the local panel (never raw SSH hostnames).
 */
export type WorkspaceHostKind = 'local' | 'ssh' | 'wsl'

/**
 * Redacted numeric-only metrics from one `agent.listSessions` entry.
 * `title`, `branch`, and `agent` are intentionally omitted.
 */
export type SessionMetrics = {
  sessionId: string
  workspaceId: string | null
  messageCount: number
  totalTokens: number
  updatedAt: number
  running: boolean
}

/**
 * One ranked row in the local panel Leaderboards card.
 * Contains only display name and numeric aggregates (no ids, paths, or titles).
 */
export type WorkspaceLeaderboardRow = {
  name: string
  messages: number
  tokens: number
}

/**
 * Compact numeric counts for the live active agent session on Discord.
 */
export type ActiveSessionStats = {
  tokens: number
  messages: number
}

/**
 * Classify an Orca `hostId` into a coarse local-panel badge without leaking
 * SSH connection names or hostnames.
 */
export function classifyHostKind(hostId: string | null | undefined): WorkspaceHostKind {
  if (typeof hostId !== 'string' || hostId.length === 0 || hostId === 'local') {
    return 'local'
  }
  if (hostId.startsWith('ssh:')) {
    return 'ssh'
  }
  if (hostId.startsWith('runtime:')) {
    return 'wsl'
  }
  return 'local'
}

/**
 * Parse a host `workspace.list` result into redacted {@link WorkspaceInfo} rows.
 * `path` is immediately discarded and never retained.
 */
export function parseWorkspaceList(result: unknown): WorkspaceInfo[] {
  if (!result || typeof result !== 'object') {
    return []
  }
  const rows = (result as Record<string, unknown>).workspaces
  if (!Array.isArray(rows)) {
    return []
  }
  const parsed: WorkspaceInfo[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const source = row as Record<string, unknown>
    const id = typeof source.id === 'string' ? source.id.trim() : ''
    const name = typeof source.name === 'string' ? source.name.trim() : ''
    if (!id || !name) {
      continue
    }
    const project =
      typeof source.project === 'string' && source.project.trim().length > 0
        ? source.project.trim()
        : undefined
    const hostId = typeof source.hostId === 'string' && source.hostId.length > 0 ? source.hostId : null
    const status =
      source.status && typeof source.status === 'object'
        ? (source.status as Record<string, unknown>)
        : null
    const statusState = typeof status?.state === 'string' ? status.state : undefined
    const terminalCount =
      typeof status?.terminalCount === 'number' && Number.isFinite(status.terminalCount) && status.terminalCount >= 0
        ? Math.floor(status.terminalCount)
        : 0
    parsed.push({
      id,
      name,
      ...(project ? { project } : {}),
      hostId,
      hostKind: classifyHostKind(hostId),
      ...(statusState ? { statusState } : {}),
      terminalCount
    })
  }
  return parsed
}

/**
 * Parse a host `agent.listSessions` result into numeric-only {@link SessionMetrics}.
 * `title` is immediately discarded and never retained.
 */
export function parseSessionsList(result: unknown): SessionMetrics[] {
  if (!result || typeof result !== 'object') {
    return []
  }
  const rows = (result as Record<string, unknown>).sessions
  if (!Array.isArray(rows)) {
    return []
  }
  const parsed: SessionMetrics[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const source = row as Record<string, unknown>
    const sessionId = typeof source.sessionId === 'string' ? source.sessionId.trim() : ''
    if (!sessionId) {
      continue
    }
    const workspaceId =
      typeof source.workspaceId === 'string' && source.workspaceId.trim().length > 0
        ? source.workspaceId.trim()
        : null
    const messageCount =
      typeof source.messageCount === 'number' && Number.isFinite(source.messageCount) && source.messageCount > 0
        ? Math.floor(source.messageCount)
        : 0
    const totalTokens =
      typeof source.totalTokens === 'number' && Number.isFinite(source.totalTokens) && source.totalTokens > 0
        ? Math.floor(source.totalTokens)
        : 0
    const updatedAt =
      typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt)
        ? source.updatedAt
        : 0
    parsed.push({
      sessionId,
      workspaceId,
      messageCount,
      totalTokens,
      updatedAt,
      running: source.running === true
    })
  }
  return parsed
}

/**
 * Format a positive count compactly for Discord Rich Presence (`950`, `1.2k`, `142k`, `1.4M`).
 */
export function formatCompactCount(count: number): string {
  const n = Math.max(0, Math.floor(count))
  if (n < 1_000) {
    return String(n)
  }
  if (n < 10_000) {
    const k = Math.round(n / 100) / 10
    return k >= 10 ? `${Math.round(k)}k` : `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  if (n < 1_000_000) {
    const k = Math.round(n / 1_000)
    return k >= 1_000 ? '1M' : `${k}k`
  }
  const m = Math.round(n / 100_000) / 10
  return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`
}

/**
 * Aggregate live token and message counts across active sessions (`slot.sessionId`
 * matches and `session.running === true`).
 *
 * Prefers live sessions in `focusedWorkspaceId` when they provide counts, and
 * falls back to summing all live/running sessions across Orca so a single
 * 0-token session (e.g. an agent adapter that reports messages without tokens)
 * never hides tokens from other running agents. Returns `undefined` when both
 * totals are zero.
 */
export function resolveActiveSessionStats(
  slots: readonly AgentSlot[],
  sessions: readonly SessionMetrics[],
  focusedWorkspaceId?: string
): ActiveSessionStats | undefined {
  if (sessions.length === 0) {
    return undefined
  }
  const bySessionId = new Map<string, SessionMetrics>()
  for (const session of sessions) {
    bySessionId.set(session.sessionId, session)
  }
  const activeIds = new Set<string>()
  const focusedIds = new Set<string>()
  for (const slot of slots) {
    if (typeof slot.sessionId === 'string' && bySessionId.has(slot.sessionId)) {
      activeIds.add(slot.sessionId)
      if (
        focusedWorkspaceId &&
        (slot.workspaceId === focusedWorkspaceId || slot.workspaceListId === focusedWorkspaceId)
      ) {
        focusedIds.add(slot.sessionId)
      }
    }
  }
  for (const session of sessions) {
    if (session.running) {
      activeIds.add(session.sessionId)
      if (focusedWorkspaceId && session.workspaceId === focusedWorkspaceId) {
        focusedIds.add(session.sessionId)
      }
    }
  }
  const sumIds = (ids: ReadonlySet<string>): ActiveSessionStats => {
    let tokens = 0
    let messages = 0
    for (const id of ids) {
      const s = bySessionId.get(id)
      if (!s) continue
      tokens += s.totalTokens
      messages += s.messageCount
    }
    return { tokens, messages }
  }
  const focusedTotals = focusedIds.size > 0 ? sumIds(focusedIds) : { tokens: 0, messages: 0 }
  const allTotals = activeIds.size > 0 ? sumIds(activeIds) : { tokens: 0, messages: 0 }
  const tokens = focusedTotals.tokens > 0 ? focusedTotals.tokens : allTotals.tokens
  const messages = focusedTotals.messages > 0 ? focusedTotals.messages : allTotals.messages
  if (tokens <= 0 && messages <= 0) {
    return undefined
  }
  return { tokens, messages }
}

/**
 * Aggregate local/WSL session history into ranked workspace rows for the panel
 * Leaderboards card.
 *
 * Rows are matched to known display names from `workspaces` so raw workspace
 * ids or paths can never surface. Returns up to `maxRows` rows (union of top
 * by tokens and top by messages, sorted by tokens desc) so the panel can toggle
 * between Messages and Tokens sorting client-side without losing leaders.
 */
export function buildWorkspaceLeaderboard(
  sessions: readonly SessionMetrics[],
  workspaces: ReadonlyMap<string, Pick<WorkspaceInfo, 'name'>>,
  maxRows = 10
): WorkspaceLeaderboardRow[] {
  const totals = new Map<string, WorkspaceLeaderboardRow>()
  for (const session of sessions) {
    if (!session.workspaceId) {
      continue
    }
    if (session.messageCount <= 0 && session.totalTokens <= 0) {
      continue
    }
    const ws = workspaces.get(session.workspaceId)
    if (!ws || !ws.name) {
      continue
    }
    const existing = totals.get(session.workspaceId)
    if (existing) {
      existing.messages += session.messageCount
      existing.tokens += session.totalTokens
    } else {
      totals.set(session.workspaceId, {
        name: ws.name,
        messages: session.messageCount,
        tokens: session.totalTokens
      })
    }
  }
  const all = [...totals.values()]
  if (all.length === 0) {
    return []
  }
  const byTokens = [...all].sort(
    (a, b) => b.tokens - a.tokens || b.messages - a.messages || a.name.localeCompare(b.name)
  )
  const byMessages = [...all].sort(
    (a, b) => b.messages - a.messages || b.tokens - a.tokens || a.name.localeCompare(b.name)
  )
  const keep = new Set<WorkspaceLeaderboardRow>()
  const half = Math.max(5, Math.ceil(maxRows / 2))
  for (const row of byTokens.slice(0, half)) {
    keep.add(row)
  }
  for (const row of byMessages.slice(0, half)) {
    keep.add(row)
  }
  return [...keep]
    .sort((a, b) => b.tokens - a.tokens || b.messages - a.messages || a.name.localeCompare(b.name))
    .slice(0, maxRows)
}
