/**
 * Discord client detection, controller factory, and rebind policy.
 *
 * Keeps socket paths inside the worker, enforces the 60s client-scan throttle,
 * handles fallback-to-chosen client takeover, and preserves Clear holds across
 * automatic rebinds while releasing them on user setting changes.
 *
 * @module worker/discord-binding
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { createDiscordClient, type DiscordClient } from '../discord/client'
import {
  AUTO_CLIENT,
  detectDiscordClients,
  resolveClientCandidates,
  summarizeClients,
  type DetectedClient
} from '../discord/detect'
import { defaultDiscordIpcCandidates } from '../discord/ipc'
import { createBridgeTransport } from '../bridge/transport'
import { createPresenceController, type PresenceController } from '../presence/controller'
import type { DiagnosticSink } from '../presence/log'
import type { PresenceSettings } from '../presence/settings'
import type { Disposer } from './host'
import type { SettingsRuntime } from './settings-runtime'

/**
 * Minimum gap between Discord client scans. Why: each scan dials up to ~240
 * sockets, so it rides the heartbeat instead of running on every event.
 */
export const DETECT_MIN_INTERVAL_MS = 60_000

export type DiscordBinding = {
  controller: () => PresenceController
  /** Probe Discord sockets and rebind if a chosen client appeared after fallback. */
  redetect: (force?: boolean) => Promise<{ rebound: boolean }>
  /** Apply normalized settings, rebinding the Discord client when required. */
  applySettings: (nextSettings: PresenceSettings, options?: { rebind?: boolean }) => Promise<void>
  stop: () => Promise<void>
}

export function createDiscordBinding({
  settingsRuntime,
  disposer,
  diagnostics,
  log,
  detectClients = detectDiscordClients,
  makeDiscordClient = createDiscordClient,
  now = () => Date.now(),
  detectMinIntervalMs = DETECT_MIN_INTERVAL_MS,
  onHealthChange,
  onNeedsHistory,
  onRepublish,
  onAfterApply
}: {
  settingsRuntime: SettingsRuntime
  disposer: Disposer
  diagnostics?: DiagnosticSink
  log: (message: string) => void
  detectClients?: typeof detectDiscordClients
  makeDiscordClient?: typeof createDiscordClient
  now?: () => number
  detectMinIntervalMs?: number
  onHealthChange: () => void
  onNeedsHistory: () => Promise<void>
  onRepublish: (options: { force?: boolean; resume?: boolean }) => Promise<void>
  onAfterApply: () => void
}): DiscordBinding {
  let detected: DetectedClient[] = []
  let lastDetectAt = 0
  let activeDiscord: DiscordClient | null = null

  function buildController(nextSettings: PresenceSettings): PresenceController {
    const discord = makeDiscordClient({
      clientId: nextSettings.applicationId,
      candidates: () =>
        resolveClientCandidates(nextSettings.discordClient, detected, defaultDiscordIpcCandidates())
          .candidates,
      log: (message, level = 'error') => diagnostics?.line(level, 'discord.client', { reason: message })
    })
    activeDiscord = discord
    return createPresenceController({
      client: discord,
      describeClient: () =>
        summarizeClients({
          connectedPath: discord.connectedPath(),
          choice: nextSettings.discordClient,
          detected
        }),
      bridge: createBridgeTransport({
        log: (message) => diagnostics?.line('error', 'bridge.transport', { reason: message })
      }),
      settings: nextSettings,
      diagnostics,
      log,
      onHealthChange
    })
  }

  let controller = buildController(settingsRuntime.current())

  async function applySettings(nextSettings: PresenceSettings, options: { rebind?: boolean } = {}) {
    const prev = settingsRuntime.current()
    // Why: both are fixed when the Discord client is built (handshake client_id,
    // candidate list), so either change recreates it.
    const applicationIdChanged = nextSettings.applicationId !== prev.applicationId
    const clientChanged = nextSettings.discordClient !== prev.discordClient
    const sessionStatsChanged = nextSettings.showSessionStats !== prev.showSessionStats
    const needsHistoryNow =
      (nextSettings.showLeaderboards && !prev.showLeaderboards) ||
      (sessionStatsChanged && nextSettings.showSessionStats !== 'off')

    settingsRuntime.setCurrent(nextSettings)
    diagnostics?.setDebugEnabled(nextSettings.debugLogging)

    if (needsHistoryNow) {
      await onNeedsHistory()
    }

    if (applicationIdChanged || clientChanged || options.rebind) {
      diagnostics?.line(
        'info',
        applicationIdChanged ? 'discord.app_id_rebind' : 'discord.client_rebind',
        applicationIdChanged
          ? { applicationId: nextSettings.applicationId }
          : { client: nextSettings.discordClient }
      )
      // Why: Rich Presence: Clear holds republishing until the next agent or
      // workspace event. An automatic rebind (re-detection switching clients)
      // must inherit that hold, or the next heartbeat would publish against the
      // person's choice. A setting the person changed is itself an action, so it
      // releases the hold, the same as other settings do via setSettings.
      const userChanged = applicationIdChanged || clientChanged
      const held = !userChanged && controller.status().heldClear
      await controller.stop()
      controller = buildController(nextSettings)
      if (held) {
        await controller.clear()
      } else if (!disposer.isDisposed()) {
        // Why: a fresh controller has published nothing, so the presence would
        // go blank until the next event or heartbeat.
        await onRepublish({ force: true })
      }
    } else {
      await controller.setSettings(nextSettings)
      if (sessionStatsChanged && nextSettings.showSessionStats !== 'off' && !disposer.isDisposed()) {
        // Why: forceTransmit bypasses the 15s debounce that setSettings just reset,
        // so selecting Tokens / Messages / Both updates Discord and preview immediately.
        await onRepublish({ force: true, resume: true })
      }
    }
    onAfterApply()
  }

  return {
    controller: () => controller,
    async redetect(force = false) {
      const clock = now()
      if (!force && lastDetectAt > 0 && clock - lastDetectAt < detectMinIntervalMs) {
        return { rebound: false }
      }
      lastDetectAt = clock
      const found = await detectClients()
      if (disposer.isDisposed()) {
        return { rebound: false }
      }
      detected = found
      // Why: a chosen client that starts after the fallback connected would never
      // get presence, since the live socket stays up. Rebuild through the same
      // path a `discordClient` change takes; the caller republishes afterwards.
      const current = settingsRuntime.current()
      const chosen =
        current.discordClient === AUTO_CLIENT
          ? undefined
          : found.find((client) => client.id === current.discordClient)
      const connectedPath = activeDiscord?.connectedPath() ?? null
      if (chosen && connectedPath !== null && connectedPath !== chosen.path) {
        await applySettings(current, { rebind: true })
        return { rebound: true }
      }
      return { rebound: false }
    },
    applySettings,
    async stop() {
      await controller.stop()
    }
  }
}
