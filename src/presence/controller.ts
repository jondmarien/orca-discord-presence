/**
 * Presence controller: snapshot cache, Discord rate-limit debounce, reconnect.
 *
 * Discord throttles `SET_ACTIVITY`. Agent hooks fire far faster than that
 * during a tool-use run, so every write funnels through
 * {@link MIN_UPDATE_INTERVAL_MS}. Connect failures (Discord not running)
 * are swallowed and retried on the next update. User-initiated
 * {@link PresenceController.setSettings} bypasses the debounce.
 *
 * @module presence/controller
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { buildActivity, type DiscordActivity, type PresenceSnapshot } from './activity'
import type { PresenceSettings } from './settings'

/**
 * Minimum time between Discord `SET_ACTIVITY` writes (15 seconds).
 *
 * The first update after a quiet period transmits immediately. Later
 * updates inside the window coalesce to a single deferred write of the
 * newest snapshot.
 *
 * @author Jonathan Marien
 */
export const MIN_UPDATE_INTERVAL_MS = 15_000

/**
 * Discord client surface the controller depends on (real or test fake).
 *
 * @author Jonathan Marien
 */
export type PresenceClient = {
  connect: () => Promise<void>
  isConnected: () => boolean
  setActivity: (activity: DiscordActivity) => Promise<unknown>
  clearActivity: () => Promise<unknown>
  close: () => Promise<void>
}

/**
 * Construction options for {@link createPresenceController}.
 *
 * Timer and clock hooks are injectable so unit tests can advance time
 * without real `setTimeout`.
 *
 * @author Jonathan Marien
 */
export type PresenceControllerOptions = {
  client: PresenceClient
  settings: PresenceSettings
  /** Clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number
  /** Schedule a deferred transmit. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** Cancel a timer returned by `setTimer`. Defaults to `clearTimeout`. */
  clearTimer?: (timer: unknown) => void
  /** Diagnostic logger for connect / set / clear failures. */
  log?: (message: string) => void
}

/**
 * Snapshot returned by **Discord Presence: Show Status**.
 *
 * `enabled` is true only when the master switch is on **and**
 * `detailLevel !== 'off'`. `lastActivity` is the last payload successfully
 * sent to Discord (or `null` after a clear).
 *
 * @author Jonathan Marien
 */
export type PresenceStatus = {
  enabled: boolean
  connected: boolean
  detailLevel: PresenceSettings['detailLevel']
  lastActivity: DiscordActivity | null
}

/**
 * Stateful presence coordinator used by the plugin worker.
 *
 * @author Jonathan Marien
 */
export type PresenceController = {
  /** Merge a partial snapshot and schedule or skip a Discord write. */
  update: (nextSnapshot: PresenceSnapshot) => Promise<void>
  /**
   * Replace settings. Disable / `off` clears immediately. Other changes
   * transmit at once (debounce bypass) so a command feels instant.
   */
  setSettings: (nextSettings: PresenceSettings) => Promise<void>
  /** Current settings object (same reference the controller holds). */
  settings: () => PresenceSettings
  /** Connection + last transmitted activity for the status command. */
  status: () => PresenceStatus
  /** Cancel a pending timer, clear activity, close the client. */
  stop: () => Promise<void>
}

/**
 * Create a presence controller bound to a Discord client and settings.
 *
 * @param options - Client, initial settings, optional clock/timer/log.
 * @returns A {@link PresenceController}.
 * @author Jonathan Marien
 */
export function createPresenceController({
  client,
  settings,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  log = () => {}
}: PresenceControllerOptions): PresenceController {
  let currentSettings = settings
  let snapshot: PresenceSnapshot | null = null
  let lastSentSerialized: string | null = null
  let lastActivity: DiscordActivity | null = null
  let lastSentAt = 0
  let pendingTimer: unknown = null
  let cleared = true

  async function ensureConnected() {
    if (client.isConnected()) {
      return true
    }
    try {
      await client.connect()
      return true
    } catch (error) {
      // Discord not running is the common case. Stay quiet; retry next update.
      const message = error instanceof Error ? error.message : String(error)
      log(`discord unavailable: ${message}`)
      return false
    }
  }

  async function transmit() {
    pendingTimer = null
    if (!snapshot) {
      return
    }
    const activity = buildActivity(snapshot, currentSettings, now())
    if (!activity) {
      await clearPresence()
      return
    }
    const serialized = JSON.stringify(activity)
    if (serialized === lastSentSerialized) {
      return
    }
    if (!(await ensureConnected())) {
      return
    }
    try {
      await client.setActivity(activity)
      lastSentSerialized = serialized
      lastActivity = activity
      lastSentAt = now()
      cleared = false
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`failed to set activity: ${message}`)
      lastSentSerialized = null
    }
  }

  async function clearPresence() {
    if (cleared) {
      return
    }
    cleared = true
    lastSentSerialized = null
    lastActivity = null
    if (!client.isConnected()) {
      return
    }
    try {
      await client.clearActivity()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`failed to clear activity: ${message}`)
    }
  }

  async function schedule() {
    if (pendingTimer) {
      return
    }
    const elapsed = now() - lastSentAt
    if (elapsed >= MIN_UPDATE_INTERVAL_MS) {
      await transmit()
      return
    }
    pendingTimer = setTimer(() => {
      void transmit()
    }, MIN_UPDATE_INTERVAL_MS - elapsed)
  }

  return {
    async update(nextSnapshot) {
      snapshot = { ...snapshot, ...nextSnapshot }
      if (!currentSettings.enabled || currentSettings.detailLevel === 'off') {
        await clearPresence()
        return
      }
      // Cheap pre-check: skip scheduling when the rendered activity is
      // unchanged, so a chatty event stream costs nothing.
      const candidate = buildActivity(snapshot, currentSettings, now())
      if (candidate && JSON.stringify(candidate) === lastSentSerialized) {
        return
      }
      await schedule()
    },
    async setSettings(nextSettings) {
      currentSettings = nextSettings
      if (!currentSettings.enabled || currentSettings.detailLevel === 'off') {
        if (pendingTimer) {
          clearTimer(pendingTimer)
          pendingTimer = null
        }
        await clearPresence()
        return
      }
      // A settings change is user-initiated and rare: bypass the debounce.
      lastSentSerialized = null
      await transmit()
    },
    settings: () => currentSettings,
    status: () => ({
      enabled: currentSettings.enabled && currentSettings.detailLevel !== 'off',
      connected: client.isConnected(),
      detailLevel: currentSettings.detailLevel,
      lastActivity
    }),
    async stop() {
      if (pendingTimer) {
        clearTimer(pendingTimer)
        pendingTimer = null
      }
      await clearPresence()
      await client.close()
    }
  }
}
