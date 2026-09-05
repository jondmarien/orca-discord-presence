/**
 * Presence controller: snapshot cache, Discord rate-limit debounce, reconnect.
 *
 * Discord throttles `SET_ACTIVITY`. Agent hooks fire far faster than that
 * during a tool-use run, so every write funnels through
 * {@link MIN_UPDATE_INTERVAL_MS}. Connect failures (Discord not running)
 * are swallowed and retried on the next update; if the opt-in HTTP bridge
 * is configured, that retry path POSTs to the companion instead. User-initiated
 * {@link PresenceController.setSettings} bypasses the debounce.
 *
 * @module presence/controller
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { buildActivity, type DiscordActivity, type PresenceSnapshot } from './activity'
import { resolveBridgeTarget, type PresenceBridge } from './bridge'
import { formatLogLine, type DiagnosticSink } from './log'
import type { PresenceSettings } from './settings'

/**
 * Last successful publish path. `null` after a clear or before the first
 * successful write. Local IPC wins when connected; the HTTP bridge is the
 * fallback when Discord is not running on the Orca host.
 *
 * @author Jonathan Marien
 */
export type PresenceSink = 'local' | 'bridge'

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
  /**
   * Optional companion transport. Required for the HTTP fallback; ignored
   * when {@link resolveBridgeTarget} returns `null`.
   */
  bridge?: PresenceBridge
  /** Clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number
  /** Schedule a deferred transmit. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown
  /** Cancel a timer returned by `setTimer`. Defaults to `clearTimeout`. */
  clearTimer?: (timer: unknown) => void
  /** Diagnostic logger for connect / set / clear failures. */
  log?: (message: string) => void
  /**
   * Structured sink (`orca.log` + file). When omitted, {@link log} receives
   * {@link formatLogLine} strings so existing tests stay a no-op.
   */
  diagnostics?: Pick<DiagnosticSink, 'line'> & { filePath?: string }
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
  /** Local Discord IPC handshake is up (not the HTTP companion). */
  connected: boolean
  /** Whether the operator enabled the companion bridge (not "reachable"). */
  bridgeEnabled: boolean
  /** Last successful publish path, or `null` if cleared / never sent. */
  sink: PresenceSink | null
  detailLevel: PresenceSettings['detailLevel']
  lastActivity: DiscordActivity | null
  /** On-disk log path when a diagnostic sink is wired (Show Status). */
  logFile: string | null
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
  /**
   * Re-`SET_ACTIVITY` even when the rendered JSON is unchanged.
   *
   * Why: Discord (or another IPC client) can replace our activity after we
   * recorded a successful send. The 90 s heartbeat and **Show Status** use
   * this so a later client does not leave a stale “already sent” skip.
   */
  forceTransmit: () => Promise<void>
  /** Current settings object (same reference the controller holds). */
  settings: () => PresenceSettings
  /** Connection + last transmitted activity + log path for the status command. */
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
  bridge,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  log = () => {},
  diagnostics
}: PresenceControllerOptions): PresenceController {
  let currentSettings = settings
  let snapshot: PresenceSnapshot | null = null
  let lastSentSerialized: string | null = null
  let lastActivity: DiscordActivity | null = null
  let lastSentAt = 0
  let pendingTimer: unknown = null
  let cleared = true
  let lastSink: PresenceSink | null = null
  let lastBridgeUrl: string | null = null
  let lastBridgeToken: string | null = null

  function emit(
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    detail?: Record<string, unknown>
  ) {
    if (diagnostics) {
      diagnostics.line(level, event, detail)
      return
    }
    log(formatLogLine(level, event, detail))
  }

  function bridgeOrigin(url: string): string {
    try {
      return new URL(url).origin
    } catch {
      return '(invalid)'
    }
  }

  async function ensureConnected() {
    if (client.isConnected()) {
      return true
    }
    try {
      await client.connect()
      emit('info', 'discord.connect_ok')
      return true
    } catch (error) {
      // Discord not running is the common case. Always log; retry next update.
      const message = error instanceof Error ? error.message : String(error)
      emit('error', 'discord.connect_failed', { reason: message })
      return false
    }
  }

  async function tryClearBridge(url: string, token: string) {
    if (!bridge) {
      return
    }
    try {
      emit('info', 'bridge.clear', { url: bridgeOrigin(url) })
      await bridge.clear(url, token)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit('error', 'bridge.clear_failed', { url: bridgeOrigin(url), reason: message })
    }
  }

  async function forgetBridge(clearRemote: boolean) {
    const url = lastBridgeUrl
    const token = lastBridgeToken ?? ''
    lastBridgeUrl = null
    lastBridgeToken = null
    if (clearRemote && url) {
      await tryClearBridge(url, token)
    }
  }

  /**
   * Publish policy: prefer local Discord IPC when the handshake succeeds.
   * Otherwise POST to the companion when {@link resolveBridgeTarget} is set.
   * Never dual-publish — if we switch from bridge to local, clear the remote.
   */
  async function transmit(force = false) {
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
    if (!force && serialized === lastSentSerialized) {
      return
    }
    if (await ensureConnected()) {
      try {
        await client.setActivity(activity)
        emit('info', 'discord.set_activity', { sink: 'local', details: activity.details })
        if (lastSink === 'bridge') {
          await forgetBridge(true)
        }
        lastSentSerialized = serialized
        lastActivity = activity
        lastSentAt = now()
        lastSink = 'local'
        cleared = false
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emit('error', 'discord.set_activity_failed', { reason: message })
        lastSentSerialized = null
      }
      return
    }
    const target = resolveBridgeTarget(currentSettings)
    if (!target) {
      if (currentSettings.bridgeEnabled) {
        emit('warn', 'bridge.skipped', { reason: 'url/token is not usable' })
      }
      return
    }
    if (!bridge) {
      emit('warn', 'bridge.skipped', { reason: 'no transport is configured' })
      return
    }
    try {
      emit('info', 'bridge.publish', { url: bridgeOrigin(target.url) })
      await bridge.publish(target.url, target.token, activity)
      emit('info', 'discord.set_activity', { sink: 'bridge', details: activity.details })
      lastSentSerialized = serialized
      lastActivity = activity
      lastSentAt = now()
      lastSink = 'bridge'
      lastBridgeUrl = target.url
      lastBridgeToken = target.token
      cleared = false
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit('error', 'bridge.publish_failed', { url: bridgeOrigin(target.url), reason: message })
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
    const sink = lastSink
    lastSink = null
    if (sink === 'local' || client.isConnected()) {
      try {
        await client.clearActivity()
        emit('info', 'discord.clear', { sink: 'local' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emit('error', 'discord.clear_failed', { reason: message })
      }
    }
    if (sink === 'bridge') {
      await forgetBridge(true)
    } else {
      await forgetBridge(false)
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
      const previousBridge =
        lastSink === 'bridge' && lastBridgeUrl != null
          ? { url: lastBridgeUrl, token: lastBridgeToken ?? '' }
          : null
      currentSettings = nextSettings
      if (!currentSettings.enabled || currentSettings.detailLevel === 'off') {
        if (pendingTimer) {
          clearTimer(pendingTimer)
          pendingTimer = null
        }
        await clearPresence()
        return
      }
      const nextTarget = resolveBridgeTarget(currentSettings)
      if (previousBridge && (!nextTarget || nextTarget.url !== previousBridge.url)) {
        await tryClearBridge(previousBridge.url, previousBridge.token)
        lastSink = null
        lastActivity = null
        lastSentSerialized = null
        lastBridgeUrl = null
        lastBridgeToken = null
        cleared = true
      }
      // A settings change is user-initiated and rare: bypass the debounce.
      lastSentSerialized = null
      await transmit()
    },
    async forceTransmit() {
      if (pendingTimer) {
        clearTimer(pendingTimer)
        pendingTimer = null
      }
      lastSentSerialized = null
      emit('info', 'discord.force_transmit')
      await transmit(true)
    },
    settings: () => currentSettings,
    status: () => ({
      enabled: currentSettings.enabled && currentSettings.detailLevel !== 'off',
      connected: client.isConnected(),
      bridgeEnabled: currentSettings.bridgeEnabled,
      sink: lastSink,
      detailLevel: currentSettings.detailLevel,
      lastActivity,
      logFile: diagnostics?.filePath ?? null
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
