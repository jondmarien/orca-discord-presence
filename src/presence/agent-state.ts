/**
 * Canonical agent-state aliases for Discord presence.
 *
 * Hosts and agent CLIs emit more strings than the four Rich Presence
 * assets this plugin ships. Map those aliases here, then render only
 * `working` / `blocked` / `waiting` / idle. Unknown values become idle
 * so a future or malformed state can never leak verbatim.
 *
 * @module presence/agent-state
 * @author Jonathan Marien
 * @date 2026-09-05
 */

/**
 * The four states this plugin knows how to show. `done` uses the idle
 * asset and the `idle` label in {@link buildActivity}.
 */
export type CanonicalAgentState = 'working' | 'blocked' | 'waiting' | 'done'

/**
 * Alias table after {@link normalizeStateKey}. Keys are lowercase with
 * hyphens and spaces folded to `_`.
 */
const AGENT_STATE_ALIASES: Record<string, CanonicalAgentState> = {
  working: 'working',
  running: 'working',
  active: 'working',
  in_progress: 'working',
  busy: 'working',
  thinking: 'working',
  blocked: 'blocked',
  error: 'blocked',
  failed: 'blocked',
  failure: 'blocked',
  interrupted: 'blocked',
  waiting: 'waiting',
  needs_input: 'waiting',
  needsinput: 'waiting',
  input: 'waiting',
  permission: 'waiting',
  paused: 'waiting',
  pending: 'waiting',
  done: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  idle: 'done',
  success: 'done',
  cancelled: 'done',
  canceled: 'done'
}

/**
 * Fold a raw host state into an alias-table key.
 */
function normalizeStateKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * Map a host / CLI agent state to a canonical value.
 *
 * Unknown, empty, and missing strings become `done` (idle on Discord).
 *
 * @param raw - `agent.status.changed` `state`, or undefined.
 * @returns One of {@link CanonicalAgentState}.
 */
export function canonicalizeAgentState(raw: string | undefined): CanonicalAgentState {
  if (typeof raw !== 'string') {
    return 'done'
  }
  const key = normalizeStateKey(raw)
  if (!key) {
    return 'done'
  }
  return AGENT_STATE_ALIASES[key] ?? 'done'
}
