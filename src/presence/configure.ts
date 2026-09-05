/**
 * Command-first settings patch for **Discord Presence: Configure**.
 *
 * Host `invokeCommand` may pass optional `args`. Invalid Application IDs
 * and `openUrl` values fail fast — they are not silently stored. Empty
 * `applicationId` restores the shipped snowflake.
 *
 * @module presence/configure
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { isPlausibleApplicationId } from '../discord/app-id'
import {
  FOCUSED_SURFACE_DETAILS,
  normalizeOpenButtonLabel,
  normalizeOpenUrl,
  type FocusedSurfaceDetail,
  SHIPPED_APPLICATION_ID,
  type PresenceSettings
} from './settings'

/**
 * Successful configure patch.
 */
export type PresenceConfigureOk = {
  ok: true
  settings: PresenceSettings
  changed: string[]
}

/**
 * Failed configure patch. Caller must not persist.
 */
export type PresenceConfigureError = {
  ok: false
  error: string
}

/**
 * Result of {@link applyConfigure}.
 */
export type PresenceConfigureResult = PresenceConfigureOk | PresenceConfigureError

/**
 * Apply a partial configure payload onto current settings.
 *
 * `undefined` / `null` / `{}` leave settings unchanged (`changed` is empty)
 * so a palette invoke can show help instead of writing.
 *
 * @param current - Normalized settings already in memory.
 * @param args - Host command args, or omitted.
 * @returns A patched settings object or a fail-fast error.
 */
export function applyConfigure(current: PresenceSettings, args: unknown): PresenceConfigureResult {
  if (args === undefined || args === null) {
    return { ok: true, settings: current, changed: [] }
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'Configure args must be an object' }
  }
  const source = args as Record<string, unknown>
  const next: PresenceSettings = { ...current }
  const changed: string[] = []

  if ('applicationId' in source) {
    if (typeof source.applicationId !== 'string') {
      return { ok: false, error: 'applicationId must be a string (empty restores the shipped id)' }
    }
    const trimmed = source.applicationId.trim()
    const applicationId = trimmed.length === 0 ? SHIPPED_APPLICATION_ID : trimmed
    if (!isPlausibleApplicationId(applicationId) && applicationId !== SHIPPED_APPLICATION_ID) {
      return {
        ok: false,
        error: 'Application ID is not a 17–20 digit snowflake'
      }
    }
    if (applicationId !== current.applicationId) {
      next.applicationId = applicationId
      changed.push('applicationId')
    }
  }

  if ('openUrl' in source) {
    if (typeof source.openUrl !== 'string') {
      return { ok: false, error: 'openUrl must be a string (https only; empty clears it)' }
    }
    if (source.openUrl.trim().length === 0) {
      if (current.openUrl !== '') {
        next.openUrl = ''
        changed.push('openUrl')
      }
    } else {
      const openUrl = normalizeOpenUrl(source.openUrl)
      if (!openUrl) {
        return {
          ok: false,
          error: 'openUrl must be an https:// URL (1–512 chars, no credentials in the URL)'
        }
      }
      if (openUrl !== current.openUrl) {
        next.openUrl = openUrl
        changed.push('openUrl')
      }
    }
  }

  if ('openButtonLabel' in source) {
    if (typeof source.openButtonLabel !== 'string') {
      return { ok: false, error: 'openButtonLabel must be a string' }
    }
    const openButtonLabel = normalizeOpenButtonLabel(source.openButtonLabel)
    if (openButtonLabel !== current.openButtonLabel) {
      next.openButtonLabel = openButtonLabel
      changed.push('openButtonLabel')
    }
  }

  if ('focusedSurfaceDetail' in source) {
    if (
      typeof source.focusedSurfaceDetail !== 'string' ||
      !(FOCUSED_SURFACE_DETAILS as readonly string[]).includes(source.focusedSurfaceDetail)
    ) {
      return { ok: false, error: 'focusedSurfaceDetail must be "kind" or "kind+title"' }
    }
    const focusedSurfaceDetail = source.focusedSurfaceDetail as FocusedSurfaceDetail
    if (focusedSurfaceDetail !== current.focusedSurfaceDetail) {
      next.focusedSurfaceDetail = focusedSurfaceDetail
      changed.push('focusedSurfaceDetail')
    }
  }

  const booleanArgs = [
    'showOpenButton',
    'showAgentCount',
    'showFocusedSurface',
    'showAgentType',
    'showAgentModel',
    'showAgentProfile'
  ] as const
  for (const field of booleanArgs) {
    if (!(field in source)) {
      continue
    }
    if (typeof source[field] !== 'boolean') {
      return { ok: false, error: `${field} must be a boolean` }
    }
    if (source[field] !== current[field]) {
      next[field] = source[field]
      changed.push(field)
    }
  }

  return { ok: true, settings: next, changed }
}
