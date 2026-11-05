/**
 * Privacy-safe diagnostics snapshot embedded in the Orca panel HTML.
 *
 * Panels cannot call `settings.*` or `storage.*` today (PLAN.md Task B4 /
 * issue #10). The worker therefore serializes a redacted view of status,
 * field toggles, and recent log lines into `panel/index.html` when the
 * install is writable. The Discord Application ID and bridge token are
 * never included.
 *
 * @module presence/panel-snapshot
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { localAssetName, type DiscordActivity } from './activity'
import type { CanonicalAgentState } from './agent-state'
import type { AgentSlot } from './agents'
import type { PresenceStatus } from './controller'
import { LOG_DIR_NAME, LOG_FILE_NAME } from './log'
import type { PresenceSettings } from './settings'
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
 * One agent row: no workspace, pane, terminal id or title ever.
 */
export type PresencePanelAgent = {
  kind: string
  state: CanonicalAgentState
  sinceMs: number
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
 * Read-only field toggles. Changing them still requires the command palette
 * until the host makes `settings.set` panel-callable.
 */
export type PresencePanelFields = {
  enabled: boolean
  showBranch: boolean
  showAgentState: boolean
  showTerminals: boolean
  showMachine: boolean
  showElapsed: boolean
  bridgeEnabled: boolean
  debugLogging: boolean
  showOpenButton: boolean
  showAgentCount: boolean
}

/**
 * JSON blob assigned to `window.__PRESENCE_PANEL__` / `#presence-snapshot`.
 */
export type PresencePanelSnapshot = {
  version: string
  generatedAt: string
  status: {
    enabled: boolean
    connected: boolean
    sink: PresenceStatus['sink']
    detailLevel: PresenceSettings['detailLevel']
    bridgeEnabled: boolean
    debugLogging: boolean
    lastActivity: PresencePanelActivitySummary | null
    logFile: string | null
  }
  fields: PresencePanelFields
  timeline: TimelineSlot[]
  agents: PresencePanelAgent[]
  activityCard: PresencePanelActivityCard | null
  logs: string[]
  logHint: string
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

/**
 * Privacy-safe agent rows, highest-priority state first, then oldest first.
 *
 * Why: slots carry workspace ids, pane keys and terminal ids. Rebuilding each
 * row from three fields means none of those can reach the panel.
 */
export function summarizePanelAgents(slots: readonly AgentSlot[]): PresencePanelAgent[] {
  return slots
    .map((slot) => ({
      kind: slot.kind && slot.kind.length > 0 ? slot.kind : 'agent',
      state: slot.canonicalState,
      sinceMs: slot.receivedAt
    }))
    .sort(
      (a, b) => AGENT_ROW_PRIORITY[b.state] - AGENT_ROW_PRIORITY[a.state] || a.sinceMs - b.sinceMs
    )
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
  const { enabled, connected, sink, detailLevel } = snapshot.status
  return `enabled=${enabled} connected=${connected} sink=${sink} detail=${detailLevel}`
}

/**
 * Build a redacted snapshot. `applicationId`, `bridgeToken`, `bridgeUrl`,
 * `machineLabel`, and `openUrl` are intentionally omitted.
 */
export function buildPresencePanelSnapshot(input: PresencePanelSnapshotInput): PresencePanelSnapshot {
  const { version, status, settings, logs, timeline, agents, now = new Date() } = input
  return {
    version,
    generatedAt: now.toISOString(),
    status: {
      enabled: status.enabled,
      connected: status.connected,
      sink: status.sink,
      detailLevel: status.detailLevel,
      bridgeEnabled: status.bridgeEnabled,
      debugLogging: settings.debugLogging,
      lastActivity: summarizePanelActivity(status.lastActivity),
      logFile: status.logFile
    },
    fields: {
      enabled: settings.enabled,
      showBranch: settings.showBranch,
      showAgentState: settings.showAgentState,
      showTerminals: settings.showTerminals,
      showMachine: settings.showMachine,
      showElapsed: settings.showElapsed,
      bridgeEnabled: settings.bridgeEnabled,
      debugLogging: settings.debugLogging,
      showOpenButton: settings.showOpenButton,
      showAgentCount: settings.showAgentCount
    },
    timeline: [...timeline],
    agents: summarizePanelAgents(agents),
    activityCard: summarizePanelActivityCard(status.lastActivity),
    logs: logs.map(redactPanelLogLine),
    logHint: status.logFile && status.logFile.trim() ? status.logFile : CONVENTIONAL_LOG_HINT
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
