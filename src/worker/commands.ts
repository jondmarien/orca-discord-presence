/**
 * Command palette registrations, toggle mappings, and status/configure toasts.
 *
 * @module worker/commands
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { applyConfigure } from '../presence/configure'
import type { DiagnosticSink } from '../presence/log'
import {
  nextDetailLevel,
  SHIPPED_APPLICATION_ID,
  toggleField,
  type PresenceSettings
} from '../presence/settings'
import type { DiscordBinding } from './discord-binding'
import type { AgentStatusPayload, OrcaHost, WorkspaceContext } from './host'
import type { PanelRpc } from './panel-rpc'
import type { SettingsRuntime } from './settings-runtime'

/**
 * Notification / log budget for the `transmitting=` JSON. Discord toasts
 * truncate; keep enough of `details` / `state` to confirm what was sent.
 */
const TRANSMITTING_TOAST_MAX = 180

/**
 * Compact `transmitting=…` fragment for **Show Status** (toast + log).
 */
export function formatStatusTransmitting(activity: unknown): string {
  const json = JSON.stringify(activity) ?? 'null'
  if (json.length <= TRANSMITTING_TOAST_MAX) {
    return `transmitting=${json}`
  }
  return `transmitting=${json.slice(0, TRANSMITTING_TOAST_MAX - 1)}…`
}

/**
 * Command palette ids mapped to the boolean {@link PresenceSettings} field
 * each toggle flips. Command titles live in `orca-plugin.json`.
 */
export const TOGGLE_COMMANDS = {
  'presence.toggle-branch': 'showBranch',
  'presence.toggle-agent-state': 'showAgentState',
  'presence.toggle-terminals': 'showTerminals',
  'presence.toggle-machine': 'showMachine',
  'presence.toggle-elapsed': 'showElapsed',
  'presence.toggle-bridge': 'bridgeEnabled',
  'presence.debug-logging': 'debugLogging',
  'presence.toggle-open-button': 'showOpenButton',
  'presence.toggle-agent-count': 'showAgentCount'
} as const

type ToggleCommandId = keyof typeof TOGGLE_COMMANDS

/**
 * Command ids the panel may run through `presence.run`. Anything else (the
 * field toggles, `presence.configure`) stays palette-only.
 */
export const PANEL_COMMANDS = [
  'presence.toggle',
  'presence.reload',
  'presence.clear',
  'presence.status',
  'presence.detail-level'
] as const

/** Command id accepted by the `presence.run` panel handler. */
export type PanelCommandId = (typeof PANEL_COMMANDS)[number]

/**
 * Public configure view (no bridge token). Used by **Configure** help/result.
 */
export function publicConfigureView(settings: PresenceSettings) {
  return {
    applicationId: settings.applicationId,
    shippedApplicationId: settings.applicationId === SHIPPED_APPLICATION_ID,
    openUrl: settings.openUrl,
    showOpenButton: settings.showOpenButton,
    openButtonLabel: settings.openButtonLabel,
    showAgentCount: settings.showAgentCount
  }
}

export type RefreshFn = (
  agentEvent?: AgentStatusPayload | null,
  options?: { force?: boolean; resume?: boolean; context?: WorkspaceContext | null; startup?: boolean }
) => Promise<void>

export function registerCommands({
  orca,
  settingsRuntime,
  binding,
  panelRpc,
  diagnostics,
  persist,
  refresh,
  publishStatusBar
}: {
  orca: OrcaHost
  settingsRuntime: SettingsRuntime
  binding: DiscordBinding
  panelRpc: PanelRpc
  diagnostics: DiagnosticSink
  persist: (nextSettings: PresenceSettings) => Promise<void>
  refresh: RefreshFn
  publishStatusBar: () => void
}): Map<string, () => Promise<unknown>> {
  const paletteHandlers = new Map<string, () => Promise<unknown>>()
  const registerPalette = (id: string, handler: () => Promise<unknown>) => {
    paletteHandlers.set(id, handler)
    orca.commands.register(id, handler)
  }

  registerPalette('presence.toggle', async () => {
    const current = settingsRuntime.current()
    await persist({ ...current, enabled: !current.enabled })
    await refresh()
    return { enabled: settingsRuntime.current().enabled }
  })

  registerPalette('presence.detail-level', async () => {
    const current = settingsRuntime.current()
    await persist({ ...current, detailLevel: nextDetailLevel(current.detailLevel) })
    await refresh()
    return { detailLevel: settingsRuntime.current().detailLevel }
  })

  for (const [commandId, field] of Object.entries(TOGGLE_COMMANDS) as [
    ToggleCommandId,
    (typeof TOGGLE_COMMANDS)[ToggleCommandId]
  ][]) {
    registerPalette(commandId, async () => {
      await persist(toggleField(settingsRuntime.current(), field))
      await refresh()
      return { [field]: settingsRuntime.current()[field] }
    })
  }

  // Why: `presence.open-panel` is declarative (manifest `action`), so it needs no
  // worker handler and no `workspace:write`, which `commands.run` would require.

  registerPalette('presence.status', async () => {
    await refresh(undefined, { force: true, resume: true })
    const base = binding.controller().status()
    const tokenStore = settingsRuntime.tokenStore()
    const tokenWarnings = settingsRuntime.tokenWarnings()
    const current = settingsRuntime.current()
    const status = {
      ...base,
      bridgeTokenStore: tokenStore,
      ...(tokenWarnings.length > 0 ? { warnings: tokenWarnings } : {})
    }
    const file = status.logFile ?? diagnostics.filePath
    const transmitting = formatStatusTransmitting(status.lastActivity ?? null)
    const warned = tokenWarnings.length > 0 ? ` warnings=${tokenWarnings.join('; ')}` : ''
    const summary = `enabled=${status.enabled} connected=${status.connected} client=${status.client?.id ?? 'none'} sink=${status.sink} bridge=${status.bridgeEnabled} tokenStore=${tokenStore} detail=${status.detailLevel} debug=${current.debugLogging}${warned}`
    diagnostics.line('info', 'status', {
      enabled: status.enabled,
      connected: status.connected,
      client: status.client?.id ?? 'none',
      sink: status.sink,
      bridge: status.bridgeEnabled,
      tokenStore,
      warnings: tokenWarnings,
      detail: status.detailLevel,
      debug: current.debugLogging,
      file,
      transmitting: JSON.stringify(status.lastActivity)
    })
    await orca.host.call('notifications.show', {
      title: 'Rich Presence for Discord',
      body: `${summary} ${transmitting}`
    })
    panelRpc.publish('immediate')
    return status
  })

  registerPalette('presence.reload', async () => {
    const { rebound } = await binding.redetect(true)
    diagnostics.line('info', 'discord.reload_command')
    if (!rebound || binding.controller().status().heldClear) {
      await refresh()
      await binding.controller().reload()
    }
    const status = binding.controller().status()
    const transmitting = formatStatusTransmitting(status.lastActivity ?? null)
    const summary = `reloaded connected=${status.connected} client=${status.client?.id ?? 'none'} sink=${status.sink} ${transmitting}`
    diagnostics.line('info', 'discord.reload_done', {
      connected: status.connected,
      sink: status.sink,
      transmitting: JSON.stringify(status.lastActivity)
    })
    await orca.host.call('notifications.show', {
      title: 'Rich Presence for Discord',
      body: summary
    })
    panelRpc.publish('immediate')
    return status
  })

  registerPalette('presence.clear', async () => {
    diagnostics.line('info', 'discord.clear_command')
    await binding.controller().clear()
    publishStatusBar()
    const status = binding.controller().status()
    const summary = `cleared enabled=${status.enabled} heldClear=${status.heldClear} sink=${status.sink}`
    diagnostics.line('info', 'discord.clear_done', {
      enabled: status.enabled,
      heldClear: status.heldClear,
      sink: status.sink
    })
    await orca.host.call('notifications.show', {
      title: 'Rich Presence for Discord',
      body: `${summary} Presence is cleared until the next agent event, Show Status, Reload RPC, or a settings change. enabled stays on.`
    })
    panelRpc.publish('immediate')
    return status
  })

  orca.commands.register('presence.configure', async (args) => {
    const result = applyConfigure(settingsRuntime.current(), args ?? {})
    if (!result.ok) {
      diagnostics.line('error', 'presence.configure_failed', { reason: result.error })
      await orca.host.call('notifications.show', {
        title: 'Rich Presence for Discord',
        body: result.error
      })
      return result
    }
    if (result.changed.length === 0) {
      const view = publicConfigureView(settingsRuntime.current())
      const hint =
        'Pass invokeCommand args: { applicationId, openUrl, showOpenButton, openButtonLabel, showAgentCount, bridgeToken }. Empty applicationId restores the shipped id. HTTPS openUrl only; never put secrets in the URL.'
      const body = `applicationId=${view.shippedApplicationId ? 'shipped' : view.applicationId} openUrl=${view.openUrl || '(empty)'} showOpenButton=${view.showOpenButton} showAgentCount=${view.showAgentCount} label=${view.openButtonLabel}`
      await orca.host.call('notifications.show', {
        title: 'Rich Presence for Discord',
        body: `${body} ${hint}`
      })
      return { ok: true, ...view, hint, changed: [] }
    }
    try {
      await persist(result.settings)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      diagnostics.line('error', 'presence.configure_failed', { reason: message })
      await orca.host.call('notifications.show', {
        title: 'Rich Presence for Discord',
        body: `Could not save: ${message}`
      })
      return { ok: false, error: message, message }
    }
    await refresh(undefined, { resume: true })
    const view = publicConfigureView(settingsRuntime.current())
    diagnostics.line('info', 'presence.configure', { changed: result.changed })
    await orca.host.call('notifications.show', {
      title: 'Rich Presence for Discord',
      body: `updated ${result.changed.join(', ')}`
    })
    return { ok: true, changed: result.changed, ...view }
  })

  return paletteHandlers
}
