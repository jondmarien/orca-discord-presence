// The privacy boundary. Every identifying string must pass a detail-level gate
// here; nothing downstream re-checks.

const DISCORD_TEXT_MAX = 128

// Orca's agent states (AGENT_STATUS_STATES). Anything else is treated as idle
// so a future or malformed state can never be transmitted verbatim.
const AGENT_STATE_LABELS = {
  working: { label: 'working', asset: 'state-working' },
  blocked: { label: 'blocked', asset: 'state-blocked' },
  waiting: { label: 'waiting for input', asset: 'state-waiting' },
  done: { label: 'idle', asset: 'state-idle' }
}
const IDLE = AGENT_STATE_LABELS.done

function clamp(text) {
  return text.length > DISCORD_TEXT_MAX ? `${text.slice(0, DISCORD_TEXT_MAX - 1)}…` : text
}

function buildDetails(snapshot, settings) {
  if (settings.detailLevel === 'generic') {
    return 'Working in Orca'
  }
  const name = snapshot.displayName || 'Orca'
  if (settings.detailLevel === 'workspace' || !settings.showBranch || !snapshot.branch) {
    return name
  }
  return `${name} — ${snapshot.branch}`
}

function buildState(snapshot, settings) {
  const parts = []
  if (settings.showAgentState) {
    parts.push((AGENT_STATE_LABELS[snapshot.agentState] ?? IDLE).label)
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

export function buildActivity(snapshot, settings, nowMs) {
  if (!settings.enabled || settings.detailLevel === 'off') {
    return null
  }
  const activity = { details: clamp(buildDetails(snapshot, settings)) }
  const state = buildState(snapshot, settings)
  if (state) {
    activity.state = clamp(state)
  }
  if (settings.showElapsed && typeof snapshot.stateStartedAtMs === 'number') {
    // Discord's RPC example uses seconds; a clock skew forward would render a
    // nonsense countdown, so clamp to now.
    activity.timestamps = { start: Math.floor(Math.min(snapshot.stateStartedAtMs, nowMs) / 1000) }
  }
  const small = AGENT_STATE_LABELS[snapshot.agentState] ?? IDLE
  activity.assets = {
    large_image: 'orca',
    large_text: 'Orca',
    small_image: small.asset,
    small_text: small.label
  }
  return activity
}
