/**
 * Orca plugin worker entry: wires host commands, events, and a heartbeat
 * into the Discord presence controller.
 *
 * Orca loads the bundled Node ESM at `dist/main.js` (`orca-plugin.json`
 * `main`). This module is the TypeScript source for that entry. `activate`
 * must resolve inside `PLUGIN_WORKER_READY_TIMEOUT_MS` (10s) or the host
 * SIGKILLs the worker, so the first `refresh` is fire-and-forget.
 *
 * @module main
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import os from 'node:os'
import { inspectApplicationId } from './discord/app-id'
import { createDiscordClient } from './discord/client'
import { applyBridgeEnvOverrides, createBridgeTransport } from './presence/bridge'
import { createPresenceController, type PresenceController } from './presence/controller'
import { createDiagnosticSink, resolveLogFilePath, type DiagnosticSink } from './presence/log'
import {
  normalizeSettings,
  nextDetailLevel,
  SHIPPED_APPLICATION_ID,
  toggleField,
  type PresenceSettings
} from './presence/settings'

/**
 * Interval for the `workspace.readContext` heartbeat.
 *
 * Why: the worker is reaped after `PLUGIN_WORKER_IDLE_REAP_MS` (5 min) of no
 * host calls. This poll both refreshes that clock and catches branch
 * switches, which emit no event.
 *
 * @author Jonathan Marien
 */
const HEARTBEAT_MS = 90_000

/**
 * Notification / log budget for the `transmitting=` JSON. Discord toasts
 * truncate; keep enough of `details` / `state` to confirm what was sent.
 *
 * @author Jonathan Marien
 */
const TRANSMITTING_TOAST_MAX = 180

/**
 * Compact `transmitting=…` fragment for **Show Status** (toast + log).
 *
 * @author Jonathan Marien
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
 *
 * @author Jonathan Marien
 */
const TOGGLE_COMMANDS = {
  'presence.toggle-branch': 'showBranch',
  'presence.toggle-agent-state': 'showAgentState',
  'presence.toggle-terminals': 'showTerminals',
  'presence.toggle-machine': 'showMachine',
  'presence.toggle-elapsed': 'showElapsed',
  'presence.toggle-bridge': 'bridgeEnabled',
  'presence.debug-logging': 'debugLogging'
} as const

/**
 * Command id keys of {@link TOGGLE_COMMANDS}.
 *
 * @author Jonathan Marien
 */
type ToggleCommandId = keyof typeof TOGGLE_COMMANDS

/**
 * Payload of the host `agent.status.changed` event used by this plugin.
 *
 * `state` is an Orca agent status (`working`, `blocked`, `waiting`, `done`,
 * or an unrecognized future value). `receivedAt` is the host timestamp in
 * milliseconds; the activity builder may convert it to a Discord start
 * timestamp when `showElapsed` is on.
 *
 * @author Jonathan Marien
 */
type AgentStatusPayload = {
  state: string
  receivedAt: number
}

/**
 * Subset of `workspace.readContext` this plugin reads.
 *
 * `terminals` is only used for its length. Missing `displayName` / `branch`
 * are treated as absent by the activity builder.
 *
 * @author Jonathan Marien
 */
type WorkspaceContext = {
  displayName?: string
  branch?: string
  terminals: readonly unknown[]
}

/**
 * Host object Orca injects into `activate`. This is the subset of the
 * plugin worker API this plugin actually calls — not the full host surface.
 *
 * @author Jonathan Marien
 */
export type OrcaHost = {
  /** Write a line to the plugin log (also used by **Show Status**). */
  log: (message: string) => void
  commands: {
    /** Register a command contributed in `orca-plugin.json`. */
    register: (id: string, handler: () => Promise<unknown>) => void
  }
  events: {
    /**
     * Subscribe to a host event. Manifest-declared events also wake a
     * sleeping worker; dynamic-only subscriptions do not.
     */
    on: (event: string, handler: (payload?: unknown) => Promise<void> | void) => void
  }
  host: {
    /**
     * Invoke a host method. This plugin uses `settings.get`, `settings.set`,
     * `workspace.readContext`, and `notifications.show`.
     */
    call: (method: string, args?: Record<string, unknown>) => Promise<unknown>
  }
}

let controller: PresenceController | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let diagnostics: DiagnosticSink | null = null
let deactivated = false

/**
 * Plugin entry. Loads persisted settings, constructs the Discord client and
 * presence controller, registers commands and events, and starts the
 * heartbeat. Presence is not guaranteed at this instant — the first
 * `refresh` is deferred so activate can return before the handshake timeout.
 *
 * @param orca - Host API injected by the Orca plugin worker.
 * @author Jonathan Marien
 */
export default async function activate(orca: OrcaHost) {
  deactivated = false
  const stored = (await orca.host.call('settings.get').catch(() => ({ settings: {} }))) as {
    settings?: unknown
  }
  const rawSettings =
    stored?.settings && typeof stored.settings === 'object'
      ? (stored.settings as Record<string, unknown>)
      : {}
  const appId = inspectApplicationId(rawSettings.applicationId, SHIPPED_APPLICATION_ID)
  let settings = applyBridgeEnvOverrides(normalizeSettings(stored?.settings), process.env)

  const logFile = resolveLogFilePath(process.env, {
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    platform: process.platform
  })
  diagnostics = createDiagnosticSink({
    hostLog: (message) => orca.log(message),
    filePath: logFile,
    debugEnabled: settings.debugLogging
  })
  diagnostics.line('info', 'activate', {
    version: '0.3.0',
    debug: settings.debugLogging,
    file: logFile,
    bridge: settings.bridgeEnabled
  })
  if (appId.usedFallback) {
    diagnostics.line('error', 'discord.app_id_invalid', {
      reason: appId.reason,
      rejected: appId.rejectedRaw || '(empty)',
      fallback: SHIPPED_APPLICATION_ID
    })
    void orca.host.call('notifications.show', {
      title: 'Discord Rich Presence',
      body: `Invalid Discord Application ID${appId.rejectedRaw ? ` (${appId.rejectedRaw})` : ''}. Using shipped id. ${appId.reason ?? ''}`
    })
  }

  controller = createPresenceController({
    client: createDiscordClient({
      clientId: settings.applicationId,
      log: (message, level = 'error') => diagnostics?.line(level, 'discord.client', { reason: message })
    }),
    bridge: createBridgeTransport({
      log: (message) => diagnostics?.line('error', 'bridge.transport', { reason: message })
    }),
    settings,
    diagnostics,
    log: (message) => orca.log(message)
  })

  /**
   * Persist every settings field through `settings.set`, then push the
   * normalized object into the controller (which bypasses the debounce).
   */
  async function persist(nextSettings: PresenceSettings) {
    settings = nextSettings
    diagnostics?.setDebugEnabled(nextSettings.debugLogging)
    for (const [key, value] of Object.entries(nextSettings)) {
      await orca.host.call('settings.set', { key, value }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        orca.log(`failed to persist ${key}: ${message}`)
      })
    }
    await controller?.setSettings(nextSettings)
  }

  /**
   * Merge workspace context (or a minimal snapshot) into the controller.
   *
   * A missing `workspace.readContext` used to return without `update`, so
   * generic “Working in Orca” never appeared. We still publish a minimal
   * snapshot (`machineName` + optional agent fields) in that case.
   */
  async function refresh(agentState?: AgentStatusPayload, options: { force?: boolean } = {}) {
    const context = (await orca.host.call('workspace.readContext').catch(() => null)) as
      | WorkspaceContext
      | null
    if (!context) {
      diagnostics?.line('debug', 'refresh.minimal', { reason: 'no workspace context' })
    } else if (agentState) {
      diagnostics?.line('debug', 'refresh', {
        source: 'agent.status.changed',
        agentState: agentState.state
      })
    }
    await controller?.update({
      machineName: os.hostname(),
      ...(context
        ? {
            displayName: context.displayName,
            branch: context.branch,
            terminalCount: Array.isArray(context.terminals) ? context.terminals.length : undefined
          }
        : {}),
      ...(agentState
        ? { agentState: agentState.state, stateStartedAtMs: agentState.receivedAt }
        : {})
    })
    if (options.force) {
      await controller?.forceTransmit()
    }
  }

  orca.commands.register('presence.toggle', async () => {
    await persist({ ...settings, enabled: !settings.enabled })
    await refresh()
    return { enabled: settings.enabled }
  })

  orca.commands.register('presence.detail-level', async () => {
    await persist({ ...settings, detailLevel: nextDetailLevel(settings.detailLevel) })
    await refresh()
    return { detailLevel: settings.detailLevel }
  })

  for (const [commandId, field] of Object.entries(TOGGLE_COMMANDS) as [
    ToggleCommandId,
    (typeof TOGGLE_COMMANDS)[ToggleCommandId]
  ][]) {
    orca.commands.register(commandId, async () => {
      await persist(toggleField(settings, field))
      await refresh()
      return { [field]: settings[field] }
    })
  }

  orca.commands.register('presence.status', async () => {
    await refresh(undefined, { force: true })
    const status = controller?.status()
    const file = status?.logFile ?? diagnostics?.filePath ?? ''
    const transmitting = formatStatusTransmitting(status?.lastActivity ?? null)
    const summary = `enabled=${status?.enabled} connected=${status?.connected} sink=${status?.sink} bridge=${status?.bridgeEnabled} detail=${status?.detailLevel} debug=${settings.debugLogging}`
    diagnostics?.line('info', 'status', {
      enabled: status?.enabled,
      connected: status?.connected,
      sink: status?.sink,
      bridge: status?.bridgeEnabled,
      detail: status?.detailLevel,
      debug: settings.debugLogging,
      file,
      transmitting: JSON.stringify(status?.lastActivity)
    })
    await orca.host.call('notifications.show', {
      title: 'Discord Rich Presence',
      body: `${summary} ${transmitting}`
    })
    return status
  })

  orca.commands.register('presence.reload', async () => {
    await refresh()
    diagnostics?.line('info', 'discord.reload_command')
    await controller?.reload()
    const status = controller?.status()
    const transmitting = formatStatusTransmitting(status?.lastActivity ?? null)
    const summary = `reloaded connected=${status?.connected} sink=${status?.sink} ${transmitting}`
    diagnostics?.line('info', 'discord.reload_done', {
      connected: status?.connected,
      sink: status?.sink,
      transmitting: JSON.stringify(status?.lastActivity)
    })
    await orca.host.call('notifications.show', {
      title: 'Discord Rich Presence',
      body: summary
    })
    return status
  })

  orca.events.on('agent.status.changed', async (payload) => {
    await refresh(payload as AgentStatusPayload)
  })
  orca.events.on('worktree.created', async () => {
    await refresh()
  })
  orca.events.on('worktree.removed', async () => {
    await refresh()
  })

  heartbeat = setInterval(() => {
    void refresh(undefined, { force: true })
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  // Why: fire-and-forget. `activate` must resolve inside
  // PLUGIN_WORKER_READY_TIMEOUT_MS (10s) or the host SIGKILLs the worker, and
  // the first refresh chains into a socket scan plus a 5s handshake timeout.
  void refresh()
}

/**
 * Plugin shutdown. Stops the heartbeat, clears Discord activity, and
 * closes the IPC socket. Idempotent — safe if called twice or when
 * activate never finished wiring.
 *
 * @author Jonathan Marien
 */
export async function deactivate() {
  if (deactivated) {
    return
  }
  deactivated = true
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  diagnostics?.line('info', 'deactivate')
  await controller?.stop()
  controller = null
  diagnostics = null
}
