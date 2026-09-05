import type { PresenceSettings } from './settings'

// The privacy boundary. Every identifying string must pass a detail-level gate
// here; nothing downstream re-checks.

const DISCORD_TEXT_MAX = 128

export type PresenceSnapshot = {
  displayName?: string
  branch?: string
  terminalCount?: number
  agentState?: string
  stateStartedAtMs?: number
  machineName?: string
}

export type DiscordActivity = {
  details: string
  state?: string
  timestamps?: { start: number }
  assets: {
    large_image: string
    large_text: string
    small_image: string
    small_text: string
  }
}

// Orca's agent states (AGENT_STATUS_STATES). Anything else is treated as idle
// so a future or malformed state can never be transmitted verbatim.
const AGENT_STATE_LABELS = {
  working: { label: 'working', asset: 'state-working' },
  blocked: { label: 'blocked', asset: 'state-blocked' },
  waiting: { label: 'waiting for input', asset: 'state-waiting' },
  done: { label: 'idle', asset: 'state-idle' }
} as const

const IDLE = AGENT_STATE_LABELS.done

function clamp(text: string): string {
  return text.length > DISCORD_TEXT_MAX ? `${text.slice(0, DISCORD_TEXT_MAX - 1)}…` : text
}

function agentVisual(state: string | undefined) {
  return state && state in AGENT_STATE_LABELS
    ? AGENT_STATE_LABELS[state as keyof typeof AGENT_STATE_LABELS]
    : IDLE
}

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

function buildState(snapshot: PresenceSnapshot, settings: PresenceSettings): string {
  const parts: string[] = []
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
      large_image: 'orca',
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
  return activity
}
