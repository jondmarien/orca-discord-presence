/**
 * Panel-to-Orca frame API bridge and reusable bidirectional storage+settings
 * preference mirror (`panelHidden` ↔ `hiddenPanels`, `panelOrder` ↔ `panelOrder`).
 *
 * @module panel/host-bridge
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { REQUEST_TIMEOUT_MS, SETTINGS_MIRROR_DELAY_MS } from './sections'

export type OrcaPanelApi = {
  shell?: {
    openExternal?: (url: string) => Promise<{ opened: boolean }>
  }
  plugin?: {
    request?: (name: string, input?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>
    on?: (name: string, fn: (payload: unknown) => void) => void
  }
  host?: {
    has?: (method: string) => boolean
    call?: (name: string, input?: Record<string, unknown>) => Promise<unknown>
  }
  files?: {
    saveAs?: (opts: {
      suggestedName: string
      mimeType: string
      data: string
    }) => Promise<{ status?: string } | null | undefined>
  }
  on?: (event: string, fn: (payload: unknown) => void) => void
}

declare global {
  interface Window {
    orca?: OrcaPanelApi
  }
}

export function getOrca(): OrcaPanelApi | undefined {
  return window.orca
}

export function request<T = unknown>(name: string, input?: unknown): Promise<T> {
  const orca = getOrca()
  return orca!.plugin!.request!(name, input, { timeoutMs: REQUEST_TIMEOUT_MS }) as Promise<T>
}

export function callHost(name: string, input: Record<string, unknown>, onError?: () => void): void {
  const host = getOrca()?.host
  if (!host || typeof host.call !== 'function') return
  Promise.resolve()
    .then(() => host.call!(name, input))
    .catch(() => {
      if (onError) onError()
    })
}

export function storedValue(result: unknown): unknown {
  return result && typeof result === 'object' ? (result as { value?: unknown }).value : result
}

export type MirroredPref<T> = {
  load: () => Promise<void>
  set: (next: T) => void
  syncFromSnapshot: (rawSetting: unknown) => void
}

/**
 * Bidirectional `storage:own` ↔ `settings.set` preference mirror with echo guard.
 *
 * - Storage wins on load whichever answer lands first; a click before storage
 *   answers wins over storage.
 * - Writes persist to `storage.set` immediately and mirror to `settings.set`
 *   after a 400ms debounce so rapid interactions coalesce.
 * - `awaitingEcho` prevents older snapshot echoes from undoing newer clicks;
 *   a rejected `settings.set` clears `awaitingEcho` so later Settings-page edits
 *   are adopted cleanly.
 */
export function createMirroredPref<T>(options: {
  storageKey: string
  settingKey: string
  getCurrent: () => T
  normalizeStorage: (raw: unknown) => T | null
  normalizeSetting: (raw: unknown) => T | null
  toStorageValue: (value: T) => unknown
  toSettingValue: (value: T) => string
  onApply: (value: T) => void
  canApplyExternal?: () => boolean
  mirrorImmediately?: boolean
  snapshotWins?: boolean
}): MirroredPref<T> {
  let fromStorage = false
  let fromSnapshot = false
  let settingsSig: string | null = null
  let settingsTimer: ReturnType<typeof setTimeout> | null = null
  let awaitingEcho: string | null = null

  return {
    load() {
      const host = getOrca()?.host
      if (!host || typeof host.call !== 'function') return Promise.resolve()
      return Promise.resolve()
        .then(() => host.call!('storage.get', { key: options.storageKey }))
        .then(
          (result) => {
            const raw = Array.isArray(result) ? result : storedValue(result)
            const value = options.normalizeStorage(raw)
            // Why: a user action made before storage answered is newer than what storage holds.
            if (value === null || fromStorage || (options.snapshotWins && fromSnapshot)) return
            fromStorage = true
            options.onApply(value)
          },
          () => {}
        )
    },
    set(next) {
      fromStorage = true
      options.onApply(next)
      const applied = options.getCurrent()
      callHost('storage.set', { key: options.storageKey, value: options.toStorageValue(applied) })
      const mirror = () => {
        settingsTimer = null
        const latestVal = options.toSettingValue(options.getCurrent())
        awaitingEcho = latestVal
        callHost('settings.set', { key: options.settingKey, value: latestVal }, () => {
          if (awaitingEcho === latestVal) awaitingEcho = null
        })
      }
      if (options.mirrorImmediately || typeof setTimeout !== 'function') {
        if (settingsTimer) clearTimeout(settingsTimer)
        mirror()
        return
      }
      if (settingsTimer) clearTimeout(settingsTimer)
      settingsTimer = setTimeout(mirror, SETTINGS_MIRROR_DELAY_MS)
    },
    syncFromSnapshot(rawSetting) {
      const value = options.normalizeSetting(rawSetting)
      if (value === null) return
      fromSnapshot = true
      const signature = options.toSettingValue(value)
      if (settingsTimer || awaitingEcho !== null) {
        if (signature === awaitingEcho) {
          awaitingEcho = null
          settingsSig = signature
        }
        return
      }
      if (signature === settingsSig) return
      const first = settingsSig === null
      settingsSig = signature
      if ((first && fromStorage && !options.snapshotWins) || signature === options.toSettingValue(options.getCurrent())) return
      if (options.canApplyExternal && !options.canApplyExternal()) return
      options.onApply(value)
      if (!first || options.snapshotWins) {
        fromStorage = true
        const applied = options.getCurrent()
        callHost('storage.set', { key: options.storageKey, value: options.toStorageValue(applied) })
      }
    }
  }
}
