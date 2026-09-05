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

import type { DiscordActivity } from './activity'
import type { PresenceStatus } from './controller'
import { LOG_DIR_NAME, LOG_FILE_NAME } from './log'
import type { PresenceSettings } from './settings'

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
 * and `machineLabel` are intentionally omitted.
 */
export function buildPresencePanelSnapshot(input: PresencePanelSnapshotInput): PresencePanelSnapshot {
  const { version, status, settings, logs, now = new Date() } = input
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
      debugLogging: settings.debugLogging
    },
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
