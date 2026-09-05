/**
 * Parse additive `workspace.readContext` / agent-identity fields from the
 * fork host (Orca-3 / Orca-4 / host #8). Missing keys stay undefined so
 * older hosts keep today's snapshot shape. Join keys on `focusedSurface`
 * are feature-detected and never copied into Discord strings.
 *
 * @module presence/host-context
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { parseFocusedSurfaceObject, type FocusedSurfaceObject } from './focus'

/**
 * Execution-host kinds projected by the fork (`executionHost.kind`).
 */
export const EXECUTION_HOST_KINDS = ['local', 'ssh', 'runtime'] as const

/**
 * One of {@link EXECUTION_HOST_KINDS}.
 */
export type ExecutionHostKind = (typeof EXECUTION_HOST_KINDS)[number]

/**
 * Privacy-safe agent labels from `readContext.agent` or `agent.status.changed`.
 */
export type AgentIdentity = {
  type?: string
  model?: string
  profile?: string
}

/**
 * Focused surface after kind validation. `null` means the host sent an
 * explicit empty sample (window unfocused). Optional join keys live on
 * the object when the host (#8) sends them.
 */
export type ParsedFocusedSurface = FocusedSurfaceObject | null

/**
 * Normalized `workspace.readContext` subset this plugin consumes.
 */
export type ParsedWorkspaceContext = {
  displayName?: string
  branch?: string
  terminalCount?: number
  executionHostKind?: ExecutionHostKind
  executionHostLabel?: string
  agentType?: string
  agentModel?: string
  agentProfile?: string
  focusedSurface?: ParsedFocusedSurface
  /** True when the host included the `focusedSurface` key (even if null). */
  focusedSurfacePresent: boolean
}

const AGENT_TYPE_MAX = 40
const AGENT_MODEL_MAX = 120
const AGENT_PROFILE_MAX = 80
const HOST_LABEL_MAX = 512

function optionalBoundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) {
    return undefined
  }
  return trimmed
}

function isExecutionHostKind(value: unknown): value is ExecutionHostKind {
  return typeof value === 'string' && (EXECUTION_HOST_KINDS as readonly string[]).includes(value)
}

/**
 * Parse a host `workspace.readContext` result. Returns `null` when the
 * payload is not an object (caller should publish a minimal snapshot).
 *
 * @param raw - Host method result.
 */
export function parseWorkspaceContext(raw: unknown): ParsedWorkspaceContext | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const source = raw as Record<string, unknown>
  const identity = parseAgentIdentity(source)
  const focusedSurfacePresent = Object.prototype.hasOwnProperty.call(source, 'focusedSurface')
  let focusedSurface: ParsedFocusedSurface | undefined
  if (focusedSurfacePresent) {
    focusedSurface = parseFocusedSurfaceValue(source.focusedSurface)
  }
  let executionHostKind: ExecutionHostKind | undefined
  let executionHostLabel: string | undefined
  if (source.executionHost && typeof source.executionHost === 'object') {
    const host = source.executionHost as Record<string, unknown>
    if (isExecutionHostKind(host.kind)) {
      executionHostKind = host.kind
      executionHostLabel = optionalBoundedString(host.label, HOST_LABEL_MAX)
    }
  }
  return {
    displayName: typeof source.displayName === 'string' ? source.displayName : undefined,
    branch: typeof source.branch === 'string' ? source.branch : undefined,
    terminalCount: Array.isArray(source.terminals) ? source.terminals.length : undefined,
    executionHostKind,
    executionHostLabel,
    agentType: identity.type,
    agentModel: identity.model,
    agentProfile: identity.profile,
    focusedSurface,
    focusedSurfacePresent
  }
}

/**
 * Parse `{ agent: { type, model, profile } }` from readContext or an event.
 *
 * @param raw - Object that may contain `agent`.
 */
export function parseAgentIdentity(raw: unknown): AgentIdentity {
  if (!raw || typeof raw !== 'object') {
    return { type: undefined, model: undefined, profile: undefined }
  }
  const source = raw as Record<string, unknown>
  const agent = source.agent
  if (!agent || typeof agent !== 'object') {
    return { type: undefined, model: undefined, profile: undefined }
  }
  const fields = agent as Record<string, unknown>
  return {
    type: optionalBoundedString(fields.type, AGENT_TYPE_MAX),
    model: optionalBoundedString(fields.model, AGENT_MODEL_MAX),
    profile: optionalBoundedString(fields.profile, AGENT_PROFILE_MAX)
  }
}

/**
 * Parse a focused-surface object. Unknown kinds become `undefined` so the
 * caller can treat a present-but-invalid value as "no usable focus".
 *
 * @param raw - `focusedSurface` field.
 */
export function parseFocusedSurfaceValue(raw: unknown): ParsedFocusedSurface | undefined {
  if (raw === null) {
    return null
  }
  return parseFocusedSurfaceObject(raw)
}

/**
 * Machine name for `showMachine`: explicit override, then host label, then
 * `os.hostname()`.
 */
export function resolveMachineName(input: {
  machineLabel: string | null
  executionHostLabel?: string
  hostname: string
}): string {
  if (input.machineLabel && input.machineLabel.trim()) {
    return input.machineLabel.trim()
  }
  if (input.executionHostLabel && input.executionHostLabel.trim()) {
    return input.executionHostLabel.trim()
  }
  return input.hostname
}
