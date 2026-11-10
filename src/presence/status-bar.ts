/**
 * Pure renderer for the Orca status bar item.
 *
 * Why: the item mirrors the Discord card, so it reads only what the privacy
 * gate already produced (`lastActivity.details`) and never a workspace name or
 * branch directly.
 *
 * @module presence/status-bar
 * @author Jonathan Marien
 * @date 2026-11-06
 */

import type { CanonicalAgentState } from './agent-state'
import type { PresenceStatus } from './controller'
import type { PresenceSettings } from './settings'

/** Fields sent to the host `statusBar.update` method. */
export type StatusBarPatch = {
  id: 'presence'
  text: string
  icon: 'activity' | 'warning'
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  tooltip: string
  visible: boolean
}

/** Inputs for {@link renderStatusBar}. */
export type StatusBarInput = {
  status: PresenceStatus
  settings: PresenceSettings
  agentState?: CanonicalAgentState
  agentCount: number
  elapsedStartMs?: number
  nowMs: number
}

const AGENT_TEXT: Record<Exclude<CanonicalAgentState, 'idle'>, { text: string; tone: StatusBarPatch['tone'] }> = {
  working: { text: 'Working', tone: 'accent' },
  blocked: { text: 'Blocked', tone: 'danger' },
  waiting: { text: 'Waiting', tone: 'warning' },
  done: { text: 'Done', tone: 'success' }
}

/**
 * Format a duration as `<1m`, `14m` or `2h 14m`.
 *
 * @param ms - Duration in milliseconds.
 * @returns Short human label.
 */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) {
    return '<1m'
  }
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * Render the status bar item for the current presence state.
 *
 * @param input - Status, settings, agent summary and clock.
 * @returns The {@link StatusBarPatch} to send when it differs from the last one.
 */
export function renderStatusBar({
  status,
  settings,
  agentState,
  agentCount,
  elapsedStartMs,
  nowMs
}: StatusBarInput): StatusBarPatch {
  const visible = settings.showStatusBar
  const click = 'Click to show or hide the panel.'
  if (!status.enabled || status.heldClear || settings.detailLevel === 'off') {
    return {
      id: 'presence',
      text: 'Discord off',
      icon: 'activity',
      tone: 'neutral',
      tooltip: `Discord: off. ${click}`,
      visible
    }
  }
  // Why: `sink` is the last successful route; a failing companion or failing
  // local sends are not a live connection.
  const notConnected =
    status.localFailing || (!status.connected && (status.sink !== 'bridge' || status.bridgeFailing))
  const agent = settings.showAgentState && agentState && agentState !== 'idle' ? AGENT_TEXT[agentState] : undefined
  const count = settings.showAgentCount && agentCount > 1 ? ` · ${agentCount}` : ''
  const parts = [status.lastActivity?.details]
  if (typeof elapsedStartMs === 'number' && settings.showElapsed) {
    parts.push(formatDuration(nowMs - elapsedStartMs))
  }
  parts.push(notConnected ? 'not connected' : `connected via ${status.sink ?? 'local'}`)
  return {
    id: 'presence',
    text: notConnected || !agent ? 'Discord' : `${agent.text}${count}`,
    icon: notConnected ? 'warning' : 'activity',
    tone: notConnected ? 'warning' : (agent?.tone ?? 'neutral'),
    tooltip: `Discord: ${parts.filter(Boolean).join(' · ')}. ${click}`,
    visible
  }
}
