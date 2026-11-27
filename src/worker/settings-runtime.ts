/**
 * Worker settings & bridge-token lifecycle: initial load, App ID validation,
 * secrets-first atomic persist, and debounced `settings.onDidChange` watching.
 *
 * @module worker/settings-runtime
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { inspectApplicationId, type ApplicationIdInspection } from '../discord/app-id'
import { applyBridgeEnvOverrides } from '../presence/bridge'
import {
  migrateSettingsToken,
  saveBridgeToken,
  SECRETS_UNAVAILABLE_WARNING,
  type TokenStore
} from '../presence/bridge-token'
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  SHIPPED_APPLICATION_ID,
  type PresenceSettings
} from '../presence/settings'
import { toSettingsValue, type Disposer, type OrcaHost } from './host'

/**
 * Quiet period before re-reading settings after `onDidChange`. Why: a multi-key
 * `persist` fires the feed once per key; this collapses them into one apply.
 */
export const SETTINGS_CHANGE_DEBOUNCE_MS = 250

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof PresenceSettings)[]

export function settingsEqual(a: PresenceSettings, b: PresenceSettings): boolean {
  return SETTING_KEYS.every((key) => a[key] === b[key])
}

export type SettingsRuntime = {
  /** Current normalized + env-overlaid settings. */
  current: () => PresenceSettings
  /** Replace the in-memory settings reference after applying a change. */
  setCurrent: (next: PresenceSettings) => void
  /** Where the bridge token is persisted (`secrets` or `settings`). */
  tokenStore: () => TokenStore
  /** Non-fatal token storage warnings (empty when keyring is active). */
  tokenWarnings: () => string[]
  /** Result of inspecting the persisted Application ID at startup. */
  appIdInspection: ApplicationIdInspection
  /**
   * Persist changed keys to `secrets.*` / `settings.set` atomically with
   * respect to `bridgeToken`, then invoke `onApply(next, previous)`.
   */
  persist: (
    nextSettings: PresenceSettings,
    onApply: (next: PresenceSettings, previous: PresenceSettings) => Promise<void>
  ) => Promise<void>
  /**
   * Subscribe to `orca.settings.onDidChange` (debounced) and invoke `onExternalChange`
   * only when the re-read settings differ from current in-memory settings.
   */
  watch: (onExternalChange: (next: PresenceSettings) => Promise<void>) => void
}

export async function createSettingsRuntime({
  orca,
  disposer,
  env = process.env,
  debounceMs = SETTINGS_CHANGE_DEBOUNCE_MS
}: {
  orca: OrcaHost
  disposer: Disposer
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  debounceMs?: number
}): Promise<SettingsRuntime> {
  const stored = (await orca.host.call('settings.get').catch(() => ({ settings: {} }))) as {
    settings?: unknown
  }
  const rawSettings =
    stored?.settings && typeof stored.settings === 'object'
      ? (stored.settings as Record<string, unknown>)
      : {}
  const appIdInspection = inspectApplicationId(rawSettings.applicationId, SHIPPED_APPLICATION_ID)
  const storedSettings = normalizeSettings(stored?.settings)

  // Why: the bridge token lives in secrets when the host has an OS keyring, so
  // `settings.get` alone would miss it. Merge it in before the env overlay.
  const loadedToken = await migrateSettingsToken(orca.host, storedSettings.bridgeToken)
  let tokenStore: TokenStore = loadedToken.store
  let tokenWarnings: string[] = loadedToken.warning ? [loadedToken.warning] : []
  let persistedToken = loadedToken.token
  let settings = applyBridgeEnvOverrides(
    { ...storedSettings, bridgeToken: persistedToken },
    env
  )
  let changeTimer: ReturnType<typeof setTimeout> | null = null

  return {
    current: () => settings,
    setCurrent(next) {
      settings = next
    },
    tokenStore: () => tokenStore,
    tokenWarnings: () => tokenWarnings,
    appIdInspection,
    async persist(nextSettings, onApply) {
      const previous = settings
      // Why: the token goes first. A keyring failure then leaves everything as
      // it was; writing the other fields first would apply them behind an
      // `ok:false` result, and an Application ID change would rebuild the
      // controller for nothing.
      if (nextSettings.bridgeToken !== previous.bridgeToken) {
        try {
          const store = await saveBridgeToken(orca.host, String(nextSettings.bridgeToken))
          tokenStore = store
          tokenWarnings = store === 'settings' ? [SECRETS_UNAVAILABLE_WARNING] : []
          persistedToken = String(nextSettings.bridgeToken)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          orca.log(`failed to persist bridgeToken: ${message}`)
          // Why: a token the keyring refused must not look saved; the caller
          // reports it and the old token stays in effect.
          throw error instanceof Error ? error : new Error(message)
        }
      }
      for (const [key, value] of Object.entries(nextSettings)) {
        if (key === 'bridgeToken' || previous[key as keyof PresenceSettings] === value) {
          continue
        }
        await orca.host.call('settings.set', { key, value: toSettingsValue(value) }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          orca.log(`failed to persist ${key}: ${message}`)
        })
      }
      await onApply(nextSettings, previous)
    },
    watch(onExternalChange) {
      if (!orca.settings?.onDidChange) {
        return
      }
      const subscription = orca.settings.onDidChange(() => {
        disposer.clearTimeout(changeTimer)
        changeTimer = disposer.setTimeout(() => {
          changeTimer = null
          void (async () => {
            const latest = (await orca.host.call('settings.get').catch(() => null)) as {
              settings?: unknown
            } | null
            if (disposer.isDisposed() || !latest) {
              return
            }
            const reread = normalizeSettings(latest.settings)
            // Why: a settings re-read carries no secrets-held token. Reuse the
            // already-loaded keyring token when no plaintext token appeared in
            // settings, avoiding redundant OS keyring probes on every toggle echo.
            let mergedToken = persistedToken
            if (tokenStore !== 'secrets' || reread.bridgeToken.length > 0) {
              const reloaded = await migrateSettingsToken(orca.host, reread.bridgeToken)
              tokenStore = reloaded.store
              tokenWarnings = reloaded.warning ? [reloaded.warning] : []
              persistedToken = reloaded.token
              mergedToken = reloaded.token
            }
            const next = applyBridgeEnvOverrides(
              { ...reread, bridgeToken: mergedToken },
              env
            )
            if (!settingsEqual(next, settings)) {
              await onExternalChange(next)
            }
          })()
        }, debounceMs)
      })
      disposer.add(subscription)
    }
  }
}
