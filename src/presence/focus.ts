/**
 * Focused-surface labels and privacy gates (issue #7 / Orca-4 / host #8).
 *
 * The host already truncates titles and strips paths/URLs. This module
 * decides whether Discord may see a kind (and optionally that title).
 * Optional `worktreeId` / `agentId` are join keys only — never formatted
 * into Discord copy and never shown in the panel.
 *
 * @module presence/focus
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { ACTIVITY_EXPIRY_MS, isActivityFresh } from './expiry'
import type { PresenceSettings } from './settings'

/**
 * Host join-key cap (`worktreeId` / `agentId`). Over-length values are
 * dropped rather than sliced so a truncated key cannot false-match.
 */
export const FOCUS_JOIN_KEY_MAX = 2048

/**
 * Host `PluginFocusedSurface.kind` values.
 */
export const FOCUSED_SURFACE_KINDS = [
  'terminal',
  'agent',
  'browser',
  'editor',
  'simulator',
  'command-palette'
] as const

/**
 * One of {@link FOCUSED_SURFACE_KINDS}.
 */
export type FocusedSurfaceKind = (typeof FOCUSED_SURFACE_KINDS)[number]

/**
 * Short Discord labels. Unknown kinds are never transmitted.
 */
export const FOCUSED_SURFACE_LABELS: Record<FocusedSurfaceKind, string> = {
  terminal: 'Terminal',
  agent: 'Agent',
  browser: 'Browser',
  editor: 'Editor',
  simulator: 'Simulator',
  'command-palette': 'Command palette'
}

/**
 * Snapshot fields used by {@link formatFocusedSurface}.
 */
export type FocusedSurfaceSnapshot = {
  focusedSurfaceKind?: string
  focusedSurfaceTitle?: string | null
  focusedSurfaceAtMs?: number
}

/**
 * Validated focused-surface object. Join keys are omitted when absent so
 * existing `{ kind, title }` equality tests stay stable.
 */
export type FocusedSurfaceObject = {
  kind: FocusedSurfaceKind
  title: string | null
  worktreeId?: string
  agentId?: string
}

/**
 * Parsed `ui.focus.changed` payload.
 */
export type ParsedUiFocusChanged = {
  focusedSurface: FocusedSurfaceObject | null
  receivedAt: number
}

/**
 * Parsed `ui.readFocus` result (`{ focusedSurface }`).
 */
export type ParsedUiReadFocus = {
  focusedSurface: FocusedSurfaceObject | null
}

/**
 * Cache so a missing `ui.readFocus` is not retried every heartbeat.
 */
export type UiReadFocusCache = {
  missing: boolean
}

/**
 * Where the live focus sample came from.
 */
export type FocusedSurfaceSource = 'readContext' | 'readFocus' | 'event' | 'none'

/**
 * Resolved focus used by the worker (kind/title for Discord; IDs for join).
 */
export type ResolvedFocusedSurface = {
  surface: FocusedSurfaceObject | null | undefined
  atMs?: number
  source: FocusedSurfaceSource
}

function isFocusedSurfaceKind(value: unknown): value is FocusedSurfaceKind {
  return typeof value === 'string' && (FOCUSED_SURFACE_KINDS as readonly string[]).includes(value)
}

/**
 * Parse an optional host join key. Empty / over-length / non-string → omit.
 *
 * @param raw - `worktreeId` or `agentId` from a focused surface.
 */
export function parseOptionalHostJoinKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > FOCUS_JOIN_KEY_MAX) {
    return undefined
  }
  return trimmed
}

/**
 * Parse a focused-surface object. Unknown kinds become `undefined`.
 * Extra keys (including envelope-level IDs) are ignored.
 *
 * @param raw - `focusedSurface` field.
 */
export function parseFocusedSurfaceObject(raw: unknown): FocusedSurfaceObject | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }
  const source = raw as Record<string, unknown>
  if (!isFocusedSurfaceKind(source.kind)) {
    return undefined
  }
  const title =
    source.title === null
      ? null
      : typeof source.title === 'string' && source.title.trim()
        ? source.title.trim().slice(0, 80)
        : null
  const worktreeId = parseOptionalHostJoinKey(source.worktreeId)
  const agentId = parseOptionalHostJoinKey(source.agentId)
  return {
    kind: source.kind,
    title,
    ...(worktreeId ? { worktreeId } : {}),
    ...(agentId ? { agentId } : {})
  }
}

/**
 * Parse a host `ui.focus.changed` payload. Invalid kinds are rejected so a
 * future or hostile value cannot leak. Join keys are read from the surface
 * only — the host event envelope is strict and must not carry them.
 *
 * @param raw - Event body.
 */
export function parseUiFocusChanged(raw: unknown): ParsedUiFocusChanged | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const source = raw as Record<string, unknown>
  if (typeof source.receivedAt !== 'number' || !Number.isFinite(source.receivedAt)) {
    return null
  }
  if (source.focusedSurface === null) {
    return { focusedSurface: null, receivedAt: source.receivedAt }
  }
  const surface = parseFocusedSurfaceObject(source.focusedSurface)
  if (!surface) {
    return null
  }
  return { focusedSurface: surface, receivedAt: source.receivedAt }
}

/**
 * Parse a host `ui.readFocus` result. Missing `focusedSurface` is invalid
 * (not “unfocused”). Extra keys are ignored.
 *
 * @param raw - Method result.
 */
export function parseUiReadFocus(raw: unknown): ParsedUiReadFocus | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }
  const source = raw as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(source, 'focusedSurface')) {
    return undefined
  }
  if (source.focusedSurface === null) {
    return { focusedSurface: null }
  }
  const surface = parseFocusedSurfaceObject(source.focusedSurface)
  if (!surface) {
    return undefined
  }
  return { focusedSurface: surface }
}

/**
 * Try-call `ui.readFocus`. A throw caches a miss so stock / older hosts
 * are not hammered every heartbeat.
 *
 * @param call - `orca.host.call`.
 * @param cache - Mutable miss flag.
 */
export async function probeUiReadFocus(
  call: (method: string, args?: Record<string, unknown>) => Promise<unknown>,
  cache: UiReadFocusCache
): Promise<ParsedUiReadFocus | undefined> {
  if (cache.missing) {
    return undefined
  }
  try {
    return parseUiReadFocus(await call('ui.readFocus'))
  } catch {
    cache.missing = true
    return undefined
  }
}

/**
 * Prefer `readContext.focusedSurface` when the key is present, then
 * `ui.readFocus`, then the last `ui.focus.changed` event.
 *
 * @param input - Parsed host samples.
 */
export function pickFocusedSurface(input: {
  context: { focusedSurfacePresent: boolean; focusedSurface?: FocusedSurfaceObject | null } | null
  readFocus?: ParsedUiReadFocus
  lastEvent?: ParsedUiFocusChanged | null
  nowMs: number
}): ResolvedFocusedSurface {
  if (input.context?.focusedSurfacePresent) {
    const surface = input.context.focusedSurface
    return {
      surface,
      atMs: surface ? input.nowMs : undefined,
      source: 'readContext'
    }
  }
  if (input.readFocus) {
    return {
      surface: input.readFocus.focusedSurface,
      atMs: input.readFocus.focusedSurface ? input.nowMs : undefined,
      source: 'readFocus'
    }
  }
  if (input.lastEvent) {
    return {
      surface: input.lastEvent.focusedSurface,
      atMs: input.lastEvent.focusedSurface ? input.lastEvent.receivedAt : undefined,
      source: 'event'
    }
  }
  return { surface: undefined, source: 'none' }
}

/**
 * True when the host attached at least one join key.
 *
 * @param surface - Parsed surface.
 */
export function focusedJoinKeysPresent(surface: FocusedSurfaceObject | null | undefined): boolean {
  return Boolean(surface && (surface.worktreeId || surface.agentId))
}

/**
 * Privacy-gated focused-surface label, or `null` when it must stay off Discord.
 *
 * - Toggle off / `generic` / `off` → omit.
 * - Unknown kind → omit.
 * - Stale sample (`ACTIVITY_EXPIRY_MS.long`) → omit.
 * - `workspace` → kind label only.
 * - `full` + `kind+title` + title → `Kind · title`.
 */
export function formatFocusedSurface(
  snapshot: FocusedSurfaceSnapshot,
  settings: PresenceSettings,
  nowMs: number
): string | null {
  if (!settings.showFocusedSurface) {
    return null
  }
  if (settings.detailLevel === 'off' || settings.detailLevel === 'generic') {
    return null
  }
  if (!isFocusedSurfaceKind(snapshot.focusedSurfaceKind)) {
    return null
  }
  if (
    typeof snapshot.focusedSurfaceAtMs !== 'number' ||
    !isActivityFresh(snapshot.focusedSurfaceAtMs, nowMs, ACTIVITY_EXPIRY_MS.long)
  ) {
    return null
  }
  const label = FOCUSED_SURFACE_LABELS[snapshot.focusedSurfaceKind]
  if (
    settings.detailLevel === 'full' &&
    settings.focusedSurfaceDetail === 'kind+title' &&
    typeof snapshot.focusedSurfaceTitle === 'string' &&
    snapshot.focusedSurfaceTitle.trim()
  ) {
    return `${label} · ${snapshot.focusedSurfaceTitle.trim()}`
  }
  return label
}
