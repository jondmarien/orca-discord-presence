/**
 * Privacy-gated Discord activity builder.
 *
 * This module is the privacy boundary. Every identifying string must pass a
 * detail-level gate here; nothing downstream re-checks. Unknown agent states
 * never leave this file verbatim — they map to a known state.
 *
 * @module presence/activity
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { canonicalizeAgentState } from './agent-state'
import type { PresenceSettings } from './settings'

/**
 * Discord Rich Presence text-field maximum (details / state / asset text).
 */
const DISCORD_TEXT_MAX = 128

/**
 * Workspace snapshot fed into {@link buildActivity}.
 *
 * Fields are optional because `workspace.readContext` and agent events
 * arrive independently; the controller merges partial updates.
 */
export type PresenceSnapshot = {
  /** Workspace display name from `workspace.readContext`. */
  displayName?: string
  /** Current git branch, when the host provides one. */
  branch?: string
  /** Number of terminals in the workspace context (`terminals.length`). */
  terminalCount?: number
  /** Orca agent status string (`working`, `blocked`, `waiting`, `done`, …). */
  agentState?: string
  /**
   * Host timestamp (ms) for the current agent state. Used only when
   * `showElapsed` is true; converted to Unix seconds for Discord.
   */
  stateStartedAtMs?: number
  /** `os.hostname()` of the Orca **client** (not an SSH remote). */
  machineName?: string
  /**
   * Live agent-table size after retention. Used only when
   * `showAgentCount` is on.
   */
  agentCount?: number
}

/**
 * Discord `SET_ACTIVITY` activity object this plugin emits.
 *
 * `state` and `timestamps` are omitted entirely when empty / disabled
 * (Discord treats a blank `state` poorly).
 */
export type DiscordActivity = {
  /** Primary line: generic copy, workspace name, or `name — branch`. */
  details: string
  /** Secondary line: agent label · terminals · machine, when enabled. */
  state?: string
  /** Elapsed timer start as Unix **seconds**, when `showElapsed` is on. */
  timestamps?: { start: number }
  assets: {
    /** Large image key uploaded to the Discord application (`orca`). */
    large_image: string
    large_text: string
    /**
     * Small image key: `state-working` | `state-blocked` | `state-waiting`
     * | `state-completed` | `state-idle` (each with the asset suffix).
     */
    small_image: string
    /** Human label matching the small asset (`working`, `completed`, `idle`, …). */
    small_text: string
  }
  /**
   * Discord activity buttons when sending `SET_ACTIVITY`. Official send
   * shape is `{ label, url }` (max 2). This plugin attaches at most one.
   */
  buttons?: Array<{ label: string; url: string }>
}

/**
 * Suffix on every Discord art asset key.
 *
 * Why: Discord caches asset art by key name for hours or days, so redesigned
 * icons ship under new keys (`orca-v2`) uploaded to the
 * shipped application. Bump this when the art changes again.
 */
export const DISCORD_ASSET_SUFFIX = '-v2'

/**
 * Bare state names used as Discord small-image keys. Why: the small image is a
 * badge-only asset (`working`, `completed`, …) drawn over the large `orca-v2`
 * icon, so Discord shows a clean status dot instead of a shrunken full icon.
 */
const SMALL_STATE_KEYS: ReadonlySet<string> = new Set(['working', 'blocked', 'waiting', 'completed', 'idle'])

/**
 * Local file name (in `assets/`) the panel shows for a Discord asset key.
 *
 * Why: the panel draws the full state icon (`state-working.png`), not the
 * badge, so bare state keys map to their `state-*` file; suffixed keys lose
 * {@link DISCORD_ASSET_SUFFIX}.
 */
export function localAssetName(key: string): string {
  if (SMALL_STATE_KEYS.has(key)) {
    return `state-${key}`
  }
  return key.endsWith(DISCORD_ASSET_SUFFIX) ? key.slice(0, -DISCORD_ASSET_SUFFIX.length) : key
}

/**
 * Canonical agent states and their Discord labels / Rich Presence asset
 * keys. Incoming host strings are folded through
 * {@link canonicalizeAgentState} first; anything unknown becomes `idle` so a
 * future or malformed state can never be transmitted verbatim, and never
 * claims completion.
 */
const AGENT_STATE_LABELS = {
  working: { label: 'working', asset: 'working' },
  blocked: { label: 'blocked', asset: 'blocked' },
  waiting: { label: 'waiting for input', asset: 'waiting' },
  done: { label: 'completed', asset: 'completed' },
  idle: { label: 'idle', asset: 'idle' }
} as const

/**
 * Truncate to Discord's 128-character text limit, appending an ellipsis.
 */
function clamp(text: string): string {
  return text.length > DISCORD_TEXT_MAX ? `${text.slice(0, DISCORD_TEXT_MAX - 1)}…` : text
}

/**
 * Map an agent state string to a known label/asset. Missing and unknown
 * strings are idle (never echoed).
 */
function agentVisual(state: string | undefined) {
  const canonical = canonicalizeAgentState(state)
  return AGENT_STATE_LABELS[canonical]
}

/**
 * Build the `details` line from the snapshot and privacy settings.
 *
 * - `generic` → `"Working in Orca"` (no workspace / branch).
 * - `workspace`, or `full` without `showBranch` / without a branch → name.
 * - `full` + `showBranch` + branch → `"name — branch"`.
 */
function buildDetails(snapshot: PresenceSnapshot, settings: PresenceSettings): string {
  if (settings.detailLevel === 'generic') {
    return 'Working in Orca'
  }
  const name = snapshot.displayName || 'Orca'
  if (settings.detailLevel === 'workspace' || !settings.showBranch || !snapshot.branch) {
    return name
  }
  return `${name} — ${snapshot.branch}`
}

/**
 * Build the optional `state` line (agent · terminals · machine).
 *
 * Machine identity is workspace-level information: never at `generic`,
 * even if `showMachine` is true.
 */
function buildState(snapshot: PresenceSnapshot, settings: PresenceSettings): string {
  const parts: string[] = []
  if (settings.showAgentCount && typeof snapshot.agentCount === 'number' && snapshot.agentCount > 0) {
    parts.push(`${snapshot.agentCount} agent${snapshot.agentCount === 1 ? '' : 's'}`)
  }
  if (settings.showAgentState) {
    parts.push(agentVisual(snapshot.agentState).label)
  }
  if (settings.showTerminals && typeof snapshot.terminalCount === 'number') {
    parts.push(`${snapshot.terminalCount} terminal${snapshot.terminalCount === 1 ? '' : 's'}`)
  }
  // Machine identity is workspace-level information: never at 'generic'.
  if (settings.showMachine && settings.detailLevel !== 'generic') {
    const machine = settings.machineLabel ?? snapshot.machineName
    if (machine) {
      parts.push(machine)
    }
  }
  return parts.join(' · ')
}

/**
 * Render a Discord activity from a snapshot and settings, or `null` when
 * presence must stay clear (`enabled === false` or `detailLevel === 'off'`).
 *
 * This is the only place identifying strings are chosen. Asset keys are
 * always `orca` (large) plus a `state-*` small image when an activity is
 * produced.
 *
 * @param snapshot - Merged workspace / agent fields.
 * @param settings - Normalized {@link PresenceSettings}.
 * @param nowMs - Clock for clamping a future `stateStartedAtMs`.
 * @returns A {@link DiscordActivity}, or `null` to clear presence.
 */
export function buildActivity(
  snapshot: PresenceSnapshot,
  settings: PresenceSettings,
  nowMs: number
): DiscordActivity | null {
  if (!settings.enabled || settings.detailLevel === 'off') {
    return null
  }
  const small = agentVisual(snapshot.agentState)
  const activity: DiscordActivity = {
    details: clamp(buildDetails(snapshot, settings)),
    assets: {
      large_image: `orca${DISCORD_ASSET_SUFFIX}`,
      large_text: 'Orca',
      small_image: small.asset,
      small_text: small.label
    }
  }
  const state = buildState(snapshot, settings)
  if (state) {
    activity.state = clamp(state)
  }
  if (settings.showElapsed && typeof snapshot.stateStartedAtMs === 'number') {
    // Discord's RPC example uses seconds; a clock skew forward would render a
    // nonsense countdown, so clamp to now.
    activity.timestamps = { start: Math.floor(Math.min(snapshot.stateStartedAtMs, nowMs) / 1000) }
  }
  if (settings.showOpenButton && settings.openUrl) {
    activity.buttons = [{ label: settings.openButtonLabel, url: settings.openUrl }]
  }
  return activity
}
