/**
 * Privacy-safe diagnostics snapshot pushed to the Orca panel over `panels.post`
 * and returned by `presence.snapshot`.
 *
 * The panel talks to the worker via `window.orca.plugin.request` / `plugin.on`
 * and reads/writes its own settings and storage through `window.orca.host`.
 * The Discord Application ID, bridge token, bridge URL, workspace paths, raw
 * SSH hostnames, and session history titles are never included.
 *
 * @module presence/panel-snapshot
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { localAssetName, type DiscordActivity } from './activity'
import type { CanonicalAgentState } from './agent-state'
import type { AgentSlot } from './agents'
import type { PresenceStatus } from './controller'
import type { WorkspaceHostKind, WorkspaceLeaderboardRow } from './leaderboards'
import { LOG_DIR_NAME, LOG_FILE_NAME } from './log'
import type { PresenceSettings, SessionStatsMode } from './settings'
import type { TimelineSlot } from './timeline'

/**
 * Conventional POSIX log path shown when the worker has not supplied one.
 */
export const CONVENTIONAL_LOG_HINT = `~/.local/state/${LOG_DIR_NAME}/${LOG_FILE_NAME}`

/**
 * Compact last-activity fields shown in the panel (no assets / timestamps).
 */
export type PresencePanelActivitySummary = {
  details: string
  state: string | null
}

/**
 * One agent row: no workspace, pane or terminal id ever. `title` and
 * `taskTitle` are local panel only (never Discord, bridge or logs), truncated.
 * `focusKey` is an opaque worker-local index used by `presence.focus-agent`.
 */
export type PresencePanelAgent = {
  kind: string
  title?: string
  taskTitle?: string
  state: CanonicalAgentState
  sinceMs: number
  outcome?: 'failure' | 'interruption'
  focusKey?: string
}

/**
 * The Discord card as the panel previews it (`startMs` is epoch ms).
 */
export type PresencePanelActivityCard = {
  details: string
  state: string | null
  largeImageKey: string
  smallImageKey: string
  startMs: number | null
}

/**
 * Current field toggles mirrored into the panel UI.
 */
export type PresencePanelFields = {
  enabled: boolean
  showBranch: boolean
  showProject: boolean
  showAgentState: boolean
  showTerminals: boolean
  showMachine: boolean
  showElapsed: boolean
  bridgeEnabled: boolean
  debugLogging: boolean
  showOpenButton: boolean
  showAgentCount: boolean
  showSessionStats: SessionStatsMode
  showLeaderboards: boolean
  /** `auto` or a detected client id (never a socket path). */
  discordClient: string
}

/**
 * Local workspace leaderboard payload included in the panel snapshot.
 */
export type PresencePanelLeaderboards = {
  enabled: boolean
  rows: WorkspaceLeaderboardRow[]
}

/**
 * Redacted snapshot delivered to the panel frame.
 */
export type PresencePanelSnapshot = {
  version: string
  generatedAt: string
  status: {
    enabled: boolean
    connected: boolean
    /** Handshake is up but the latest local send failed. */
    localFailing: boolean
    /** The Discord app connected over IPC, or `null`. */
    client: PresenceStatus['client']
    /** Detected Discord apps; `id` and `label` only, never a path. */
    clients: PresenceStatus['clients']
    clientFallback: boolean
    sink: PresenceStatus['sink']
    detailLevel: PresenceSettings['detailLevel']
    bridgeEnabled: boolean
    debugLogging: boolean
    lastActivity: PresencePanelActivitySummary | null
    logFile: string | null
    /** Coarse host location of the focused workspace (never an SSH hostname). */
    hostKind?: WorkspaceHostKind
  }
  fields: PresencePanelFields
  timeline: TimelineSlot[]
  agents: PresencePanelAgent[]
  activityCard: PresencePanelActivityCard | null
  logs: string[]
  logHint: string
  /** Hidden panel section ids from the `hiddenPanels` setting. */
  hidden: string[]
  /** Custom panel section order from the `panelOrder` setting (`[]` = default). */
  order: string[]
  /** Local workspace leaderboard (empty when `showLeaderboards` is false). */
  leaderboards: PresencePanelLeaderboards
}

/**
 * Inputs for {@link buildPresencePanelSnapshot}.
 */
export type PresencePanelSnapshotInput = {
  version: string
  status: PresenceStatus
  settings: PresenceSettings
  logs: readonly string[]
  timeline: TimelineSlot[]
  agents: readonly AgentSlot[]
  /** Coarse host location of the focused workspace. */
  hostKind?: WorkspaceHostKind
  /** Optional opaque handle resolver for clickable agent focus rows. */
  focusKeyOf?: (slot: AgentSlot) => string | undefined
  /** Local workspace leaderboard rows when `showLeaderboards` is on. */
  leaderboardRows?: readonly WorkspaceLeaderboardRow[]
  /** Clock for `generatedAt`. Defaults to `new Date()`. */
  now?: Date
}

/**
 * Keys that must never appear as values in a panel log line.
 */
const SECRET_ASSIGNMENT_RE =
  /\b(token|bridgetoken|authorization|password|secret)=(?!\*\*\*)(\S+)/gi

/**
 * Redact leftover secret assignments in an already-formatted log line.
 *
 * {@link formatLogLine} already replaces known keys with `***`. This is a
 * second pass so a slipped `token=value` cannot reach the panel HTML.
 */
export function redactPanelLogLine(line: string): string {
  return line.replace(SECRET_ASSIGNMENT_RE, '$1=***')
}

/**
 * Compact `details` / `state` only — never the full activity (assets omit
 * nothing secret, but the panel only needs a summary).
 */
export function summarizePanelActivity(
  activity: DiscordActivity | null | undefined
): PresencePanelActivitySummary | null {
  if (!activity || typeof activity.details !== 'string') {
    return null
  }
  return {
    details: activity.details,
    state: typeof activity.state === 'string' ? activity.state : null
  }
}

const AGENT_ROW_PRIORITY: Record<CanonicalAgentState, number> = {
  blocked: 4,
  waiting: 3,
  working: 2,
  done: 1,
  idle: 0
}

/** Longest chat title the panel snapshot carries, ellipsis included. */
export const PANEL_TITLE_MAX = 80

function panelTitle(title: string | undefined): string | undefined {
  const text = typeof title === 'string' ? title.trim() : ''
  if (!text) {
    return undefined
  }
  return text.length > PANEL_TITLE_MAX ? `${text.slice(0, PANEL_TITLE_MAX - 1)}…` : text
}

function panelOutcome(outcome: string | undefined): 'failure' | 'interruption' | undefined {
  return outcome === 'failure' || outcome === 'interruption' ? outcome : undefined
}

/**
 * Privacy-safe agent rows, highest-priority state first, then oldest first.
 *
 * Why: slots carry workspace ids, pane keys and terminal ids. Rebuilding each
 * row from kind, title, taskTitle, state, outcome and time means none of those
 * can reach the panel.
 */
export function summarizePanelAgents(
  slots: readonly AgentSlot[],
  options: { focusKeyOf?: (slot: AgentSlot) => string | undefined } = {}
): PresencePanelAgent[] {
  return [...slots]
    .sort(
      (a, b) =>
        AGENT_ROW_PRIORITY[b.canonicalState] - AGENT_ROW_PRIORITY[a.canonicalState] ||
        (a.stateStartedAt ?? a.receivedAt) - (b.stateStartedAt ?? b.receivedAt)
    )
    .map((slot) => {
      const title = panelTitle(slot.title)
      const taskTitle = panelTitle(slot.taskTitle)
      const outcome = panelOutcome(slot.outcome)
      const focusKey = options.focusKeyOf?.(slot)
      return {
        kind: slot.kind && slot.kind.length > 0 ? slot.kind : 'agent',
        ...(title ? { title } : {}),
        ...(taskTitle && taskTitle !== title ? { taskTitle } : {}),
        state: slot.canonicalState,
        sinceMs: slot.stateStartedAt ?? slot.receivedAt,
        ...(outcome ? { outcome } : {}),
        ...(focusKey ? { focusKey } : {})
      }
    })
}

/**
 * Discord card preview from the last transmitted activity.
 */
export function summarizePanelActivityCard(
  activity: DiscordActivity | null | undefined
): PresencePanelActivityCard | null {
  if (!activity || typeof activity.details !== 'string') {
    return null
  }
  return {
    details: activity.details,
    state: typeof activity.state === 'string' ? activity.state : null,
    largeImageKey: localAssetName(activity.assets.large_image),
    smallImageKey: localAssetName(activity.assets.small_image),
    startMs: activity.timestamps ? activity.timestamps.start * 1000 : null
  }
}

/**
 * Compact toast body for **Show Status** from the panel (`notifications.show`).
 *
 * Title stays `Discord Rich Presence` (host cap 120). Body is well under 1000.
 */
export function formatPanelStatusToast(snapshot: PresencePanelSnapshot): string {
  const { enabled, connected, sink, detailLevel, client } = snapshot.status
  return `enabled=${enabled} connected=${connected} client=${client?.id ?? 'none'} sink=${sink} detail=${detailLevel}`
}

/**
 * Build a redacted snapshot. `applicationId`, `bridgeToken`, `bridgeUrl`,
 * `machineLabel`, and `openUrl` are intentionally omitted.
 */
export function buildPresencePanelSnapshot(input: PresencePanelSnapshotInput): PresencePanelSnapshot {
  const {
    version,
    status,
    settings,
    logs,
    timeline,
    agents,
    hostKind,
    focusKeyOf,
    leaderboardRows = [],
    now = new Date()
  } = input
  return {
    version,
    generatedAt: now.toISOString(),
    status: {
      enabled: status.enabled,
      connected: status.connected,
      localFailing: status.localFailing,
      // Why: rebuilt field by field so a path can never ride along.
      client: status.client ? { id: status.client.id, label: status.client.label } : null,
      clients: status.clients.map(({ id, label }) => ({ id, label })),
      clientFallback: status.clientFallback,
      sink: status.sink,
      detailLevel: status.detailLevel,
      bridgeEnabled: status.bridgeEnabled,
      debugLogging: settings.debugLogging,
      lastActivity: summarizePanelActivity(status.lastActivity),
      logFile: status.logFile,
      ...(hostKind ? { hostKind } : {})
    },
    fields: {
      enabled: settings.enabled,
      showBranch: settings.showBranch,
      showProject: settings.showProject,
      showAgentState: settings.showAgentState,
      showTerminals: settings.showTerminals,
      showMachine: settings.showMachine,
      showElapsed: settings.showElapsed,
      bridgeEnabled: settings.bridgeEnabled,
      debugLogging: settings.debugLogging,
      showOpenButton: settings.showOpenButton,
      showAgentCount: settings.showAgentCount,
      showSessionStats: settings.showSessionStats,
      showLeaderboards: settings.showLeaderboards,
      discordClient: settings.discordClient
    },
    timeline: [...timeline],
    agents: summarizePanelAgents(agents, { focusKeyOf }),
    activityCard: summarizePanelActivityCard(status.lastActivity),
    logs: logs.map(redactPanelLogLine),
    logHint: status.logFile && status.logFile.trim() ? status.logFile : CONVENTIONAL_LOG_HINT,
    hidden: settings.hiddenPanels ? settings.hiddenPanels.split(',') : [],
    order: settings.panelOrder ? settings.panelOrder.split(',') : [],
    leaderboards: {
      enabled: settings.showLeaderboards,
      rows: settings.showLeaderboards
        ? leaderboardRows.map(({ name, messages, tokens }) => ({ name, messages, tokens }))
        : []
    }
  }
}

/**
 * True when serialized snapshot JSON contains a secret-shaped value.
 * Used by tests; the builder must keep this false.
 */
export function snapshotLeaksSecrets(snapshot: PresencePanelSnapshot, secrets: readonly string[]): boolean {
  const json = JSON.stringify(snapshot)
  return secrets.some((secret) => secret.length > 0 && json.includes(secret))
}
