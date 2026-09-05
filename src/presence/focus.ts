/**
 * Focused-surface labels and privacy gates (issue #7 / Orca-4).
 *
 * The host already truncates titles and strips paths/URLs. This module
 * decides whether Discord may see a kind (and optionally that title).
 *
 * @module presence/focus
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { ACTIVITY_EXPIRY_MS, isActivityFresh } from './expiry'
import type { PresenceSettings } from './settings'

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
 * Parsed `ui.focus.changed` payload.
 */
export type ParsedUiFocusChanged = {
  focusedSurface: { kind: FocusedSurfaceKind; title: string | null } | null
  receivedAt: number
}

function isFocusedSurfaceKind(value: unknown): value is FocusedSurfaceKind {
  return typeof value === 'string' && (FOCUSED_SURFACE_KINDS as readonly string[]).includes(value)
}

/**
 * Parse a host `ui.focus.changed` payload. Invalid kinds are rejected so a
 * future or hostile value cannot leak.
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
  if (!source.focusedSurface || typeof source.focusedSurface !== 'object') {
    return null
  }
  const surface = source.focusedSurface as Record<string, unknown>
  if (!isFocusedSurfaceKind(surface.kind)) {
    return null
  }
  const title =
    surface.title === null
      ? null
      : typeof surface.title === 'string' && surface.title.trim()
        ? surface.title.trim().slice(0, 80)
        : null
  return { focusedSurface: { kind: surface.kind, title }, receivedAt: source.receivedAt }
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
