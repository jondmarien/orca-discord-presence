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
  normalizeOpenButtonLabel,
  normalizeOpenUrl,
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

  if ('showOpenButton' in source) {
    if (typeof source.showOpenButton !== 'boolean') {
      return { ok: false, error: 'showOpenButton must be a boolean' }
    }
    if (source.showOpenButton !== current.showOpenButton) {
      next.showOpenButton = source.showOpenButton
      changed.push('showOpenButton')
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

  if ('showAgentCount' in source) {
    if (typeof source.showAgentCount !== 'boolean') {
      return { ok: false, error: 'showAgentCount must be a boolean' }
    }
    if (source.showAgentCount !== current.showAgentCount) {
      next.showAgentCount = source.showAgentCount
      changed.push('showAgentCount')
    }
  }

  return { ok: true, settings: next, changed }
}
