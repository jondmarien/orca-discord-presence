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
import {
  createAgentTable,
  parseAgentStatusPayload,
  parseWorktreeRemovedId,
  type AgentStatusEvent
} from './presence/agents'
import { applyBridgeEnvOverrides, createBridgeTransport } from './presence/bridge'
import { applyConfigure } from './presence/configure'
import { createPresenceController, type PresenceController } from './presence/controller'
import { writeDiagnosticsSnapshot } from './presence/diagnostics-store'
import {
  focusedJoinKeysPresent,
  parseUiFocusChanged,
  pickFocusedSurface,
  probeUiReadFocus,
  type FocusedSurfaceObject,
  type ParsedUiFocusChanged,
  type UiReadFocusCache
} from './presence/focus'
import { parseWorkspaceContext, resolveMachineName } from './presence/host-context'
import { createLogRing, type LogRing } from './presence/log-ring'
import { createDiagnosticSink, resolveLogFilePath, type DiagnosticSink } from './presence/log'
import { resolvePanelHtmlPath, writePanelSnapshot } from './presence/panel-html'
import { buildPresencePanelSnapshot, type PresencePanelHost } from './presence/panel-snapshot'
import {
  normalizeSettings,
  nextDetailLevel,
  SHIPPED_APPLICATION_ID,
  toggleField,
  type PresenceSettings
} from './presence/settings'
import { createSidecarTransport } from './presence/sidecar'
import { PLUGIN_VERSION } from './version'

/**
 * Interval for the `workspace.readContext` heartbeat.
 *
 * Why: the worker is reaped after `PLUGIN_WORKER_IDLE_REAP_MS` (5 min) of no
 * host calls. This poll both refreshes that clock and catches branch
 * switches, which emit no event.
 */
const HEARTBEAT_MS = 90_000

/**
 * Re-read `settings.get` so panel `settings.set` applies without waiting
 * for the 90 s heartbeat.
 */
const SETTINGS_POLL_MS = 5_000

/**
 * Coalesce panel HTML rewrites during a chatty agent event stream.
 */
const PANEL_WRITE_DEBOUNCE_MS = 2_000

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
const TOGGLE_COMMANDS = {
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

/**
 * Command id keys of {@link TOGGLE_COMMANDS}.
 */
type ToggleCommandId = keyof typeof TOGGLE_COMMANDS

/**
 * Host object Orca injects into `activate`. This is the subset of the
 * plugin worker API this plugin actually calls — not the full host surface.
 */
export type OrcaHost = {
  /** Write a line to the plugin log (also used by **Show Status**). */
  log: (message: string) => void
  commands: {
    /**
     * Register a command contributed in `orca-plugin.json`.
     * Host `invokeCommand` may pass optional `args`.
     */
    register: (id: string, handler: (args?: Record<string, unknown>) => Promise<unknown>) => void
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
     * Invoke a host method. This plugin uses `settings.*`,
     * `workspace.readContext`, `notifications.show`, `storage.*`,
     * `sidecar.*` (try-call), and `ui.readFocus` (try-call; host #8).
     */
    call: (method: string, args?: Record<string, unknown>) => Promise<unknown>
  }
}

let controller: PresenceController | null = null
let agentTable: ReturnType<typeof createAgentTable> | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let settingsPoll: ReturnType<typeof setInterval> | null = null
let diagnostics: DiagnosticSink | null = null
let logRing: LogRing | null = null
let panelWriteTimer: ReturnType<typeof setTimeout> | null = null
let panelWriteNoted = false
let deactivated = false

/**
 * Public configure view (no bridge token). Used by **Configure** help/result.
 */
function publicConfigureView(settings: PresenceSettings) {
  return {
    applicationId: settings.applicationId,
    shippedApplicationId: settings.applicationId === SHIPPED_APPLICATION_ID,
    openUrl: settings.openUrl,
    showOpenButton: settings.showOpenButton,
    openButtonLabel: settings.openButtonLabel,
    showAgentCount: settings.showAgentCount,
    showFocusedSurface: settings.showFocusedSurface,
    focusedSurfaceDetail: settings.focusedSurfaceDetail,
    showAgentType: settings.showAgentType,
    showAgentModel: settings.showAgentModel,
    showAgentProfile: settings.showAgentProfile
  }
}

function emptyHostCaps(): PresencePanelHost {
  return { sidecar: false, focus: false, executionHost: false }
}

/**
 * Plugin entry. Loads persisted settings, constructs the Discord client and
 * presence controller, registers commands and events, and starts the
 * heartbeat. Presence is not guaranteed at this instant — the first
 * `refresh` is deferred so activate can return before the handshake timeout.
 *
 * @param orca - Host API injected by the Orca plugin worker.
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
  const hostCaps = emptyHostCaps()
  let lastFocus: ParsedUiFocusChanged | null = null
  const uiReadFocusCache: UiReadFocusCache = { missing: false }

  const logFile = resolveLogFilePath(process.env, {
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    platform: process.platform
  })
  logRing = createLogRing()
  panelWriteNoted = false
  diagnostics = createDiagnosticSink({
    hostLog: (message) => orca.log(message),
    filePath: logFile,
    debugEnabled: settings.debugLogging,
    onEmit: (line) => {
      logRing?.push(line)
    }
  })
  diagnostics.line('info', 'activate', {
    version: PLUGIN_VERSION,
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

  const sidecar = createSidecarTransport((method, args) => orca.host.call(method, args))
  void sidecar.resolvePlacement().then((placement) => {
    hostCaps.sidecar = Boolean(placement?.mailboxAvailable)
  })

  function createController(nextSettings: PresenceSettings): PresenceController {
    return createPresenceController({
      client: createDiscordClient({
        clientId: nextSettings.applicationId,
        log: (message, level = 'error') => diagnostics?.line(level, 'discord.client', { reason: message })
      }),
      bridge: createBridgeTransport({
        log: (message) => diagnostics?.line('error', 'bridge.transport', { reason: message })
      }),
      sidecar,
      settings: nextSettings,
      diagnostics: diagnostics ?? undefined,
      log: (message) => orca.log(message)
    })
  }

  /**
   * Embed a redacted snapshot into `panel/index.html` when the install is
   * writable, and write the same blob to `storage.set` for live panel polls.
   */
  async function publishPanelSnapshot(mode: 'immediate' | 'debounced') {
    const flush = async () => {
      panelWriteTimer = null
      if (!controller || !logRing) {
        return
      }
      const snapshot = buildPresencePanelSnapshot({
        version: PLUGIN_VERSION,
        status: controller.status(),
        settings: controller.settings(),
        logs: logRing.lines(),
        host: { ...hostCaps }
      })
      await writeDiagnosticsSnapshot((method, args) => orca.host.call(method, args), snapshot)
      const target = resolvePanelHtmlPath(process.env, import.meta.url)
      if (!target) {
        return
      }
      const result = writePanelSnapshot(target, snapshot)
      if (result.ok) {
        diagnostics?.line('debug', 'panel.snapshot_written', { lines: snapshot.logs.length })
        return
      }
      if (!panelWriteNoted) {
        panelWriteNoted = true
        diagnostics?.line('debug', 'panel.snapshot_skipped', { reason: result.reason })
      }
    }
    if (mode === 'immediate') {
      if (panelWriteTimer) {
        clearTimeout(panelWriteTimer)
        panelWriteTimer = null
      }
      try {
        await flush()
      } catch {
        // Panel rewrite must never take down presence.
      }
      return
    }
    if (panelWriteTimer) {
      return
    }
    panelWriteTimer = setTimeout(() => {
      void flush().catch(() => {
        // Same as immediate: ignore rewrite errors.
      })
    }, PANEL_WRITE_DEBOUNCE_MS)
    panelWriteTimer.unref?.()
  }

  let pushAgentRefresh: () => void = () => {}
  agentTable = createAgentTable({
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    },
    onChange: () => {
      pushAgentRefresh()
    }
  })

  controller = createController(settings)

  async function readHostSettings(): Promise<PresenceSettings | null> {
    try {
      const next = (await orca.host.call('settings.get')) as { settings?: unknown }
      if (!next || typeof next !== 'object') {
        return null
      }
      return applyBridgeEnvOverrides(normalizeSettings(next.settings), process.env)
    } catch {
      return null
    }
  }

  /**
   * Persist every settings field through `settings.set`, then push the
   * normalized object into the controller (which bypasses the debounce).
   * A changed Application ID recreates the Discord client (handshake
   * `client_id` is fixed at construct time).
   */
  async function persist(nextSettings: PresenceSettings) {
    const applicationIdChanged = nextSettings.applicationId !== settings.applicationId
    settings = nextSettings
    diagnostics?.setDebugEnabled(nextSettings.debugLogging)
    for (const [key, value] of Object.entries(nextSettings)) {
      await orca.host.call('settings.set', { key, value }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        orca.log(`failed to persist ${key}: ${message}`)
      })
    }
    if (applicationIdChanged) {
      diagnostics?.line('info', 'discord.app_id_rebind', { applicationId: nextSettings.applicationId })
      await controller?.stop()
      controller = createController(nextSettings)
    } else {
      await controller?.setSettings(nextSettings)
    }
    await publishPanelSnapshot('immediate')
  }

  async function applyHostSettingsIfChanged(): Promise<void> {
    const next = await readHostSettings()
    if (!next) {
      return
    }
    if (JSON.stringify(next) === JSON.stringify(settings)) {
      return
    }
    await persist(next)
  }

  /**
   * Merge workspace context, agent table, and optional focus into the
   * controller.
   *
   * A missing `workspace.readContext` used to return without `update`, so
   * generic “Working in Orca” never appeared. We still publish a minimal
   * snapshot (`machineName` + optional agent / focus fields) in that case.
   */
  async function refresh(
    agentEvent?: AgentStatusEvent | null,
    options: { force?: boolean; resume?: boolean } = {}
  ) {
    await applyHostSettingsIfChanged()
    if (agentEvent) {
      agentTable?.upsert(agentEvent)
    }
    const parsed = parseWorkspaceContext(
      await orca.host.call('workspace.readContext').catch(() => null)
    )
    const readFocus = parsed?.focusedSurfacePresent
      ? undefined
      : await probeUiReadFocus((method, args) => orca.host.call(method, args), uiReadFocusCache)
    const resolved = pickFocusedSurface({
      context: parsed,
      readFocus,
      lastEvent: lastFocus,
      nowMs: Date.now()
    })
    if (parsed?.executionHostKind) {
      hostCaps.executionHost = true
    }
    if (parsed?.focusedSurfacePresent || readFocus || lastFocus) {
      hostCaps.focus = true
    }
    const summary = agentTable?.summarize({
      worktreeId: resolved.surface?.worktreeId,
      agentId: resolved.surface?.agentId
    }) ?? {
      agentCount: 0,
      agentState: undefined,
      stateStartedAtMs: undefined,
      agentType: undefined,
      agentModel: undefined,
      agentProfile: undefined
    }
    if (!parsed) {
      diagnostics?.line('debug', 'refresh.minimal', { reason: 'no workspace context' })
    } else if (agentEvent) {
      diagnostics?.line('debug', 'refresh', {
        source: 'agent.status.changed',
        agentState: summary.agentState ?? 'idle',
        agents: summary.agentCount,
        focusJoinKeys: focusedJoinKeysPresent(resolved.surface)
      })
    }
    const resume = Boolean(options.resume || agentEvent)
    await controller?.update(
      {
        machineName: resolveMachineName({
          machineLabel: settings.machineLabel,
          executionHostLabel: parsed?.executionHostLabel,
          hostname: os.hostname()
        }),
        ...(parsed
          ? {
              displayName: parsed.displayName,
              branch: parsed.branch,
              terminalCount: parsed.terminalCount
            }
          : {}),
        agentState: summary.agentState,
        stateStartedAtMs: summary.stateStartedAtMs,
        agentCount: summary.agentCount,
        agentType: summary.agentType ?? parsed?.agentType,
        agentModel: summary.agentModel ?? parsed?.agentModel,
        agentProfile: summary.agentProfile ?? parsed?.agentProfile,
        ...focusSnapshotFields(resolved.surface, resolved.atMs)
      },
      resume ? { resume: true } : undefined
    )
    if (options.force) {
      await controller?.forceTransmit(resume)
    }
    void publishPanelSnapshot('debounced')
  }

  pushAgentRefresh = () => {
    void refresh()
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
    await refresh(undefined, { force: true, resume: true })
    const status = controller?.status()
    const file = status?.logFile ?? diagnostics?.filePath ?? ''
    const transmitting = formatStatusTransmitting(status?.lastActivity ?? null)
    const summary = `enabled=${status?.enabled} connected=${status?.connected} sink=${status?.sink} sidecarMailbox=${status?.sidecarMailbox} bridge=${status?.bridgeEnabled} detail=${status?.detailLevel} debug=${settings.debugLogging}`
    diagnostics?.line('info', 'status', {
      enabled: status?.enabled,
      connected: status?.connected,
      sink: status?.sink,
      sidecarMailbox: status?.sidecarMailbox,
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
    await publishPanelSnapshot('immediate')
    return status
  })

  orca.commands.register('presence.reload', async () => {
    await refresh()
    diagnostics?.line('info', 'discord.reload_command')
    await controller?.reload()
    const status = controller?.status()
    const transmitting = formatStatusTransmitting(status?.lastActivity ?? null)
    const summary = `reloaded connected=${status?.connected} sink=${status?.sink} sidecarMailbox=${status?.sidecarMailbox} ${transmitting}`
    diagnostics?.line('info', 'discord.reload_done', {
      connected: status?.connected,
      sink: status?.sink,
      sidecarMailbox: status?.sidecarMailbox,
      transmitting: JSON.stringify(status?.lastActivity)
    })
    await orca.host.call('notifications.show', {
      title: 'Discord Rich Presence',
      body: summary
    })
    await publishPanelSnapshot('immediate')
    return status
  })

  orca.commands.register('presence.clear', async () => {
    diagnostics?.line('info', 'discord.clear_command')
    await controller?.clear()
    const status = controller?.status()
    const summary = `cleared enabled=${status?.enabled} heldClear=${status?.heldClear} sink=${status?.sink} sidecarMailbox=${status?.sidecarMailbox}`
    diagnostics?.line('info', 'discord.clear_done', {
      enabled: status?.enabled,
      heldClear: status?.heldClear,
      sink: status?.sink,
      sidecarMailbox: status?.sidecarMailbox
    })
    await orca.host.call('notifications.show', {
      title: 'Discord Rich Presence',
      body: `${summary} Presence is cleared until the next agent event, Show Status, Reload RPC, or a settings change. enabled stays on.`
    })
    await publishPanelSnapshot('immediate')
    return status
  })

  orca.commands.register('presence.configure', async (args) => {
    const result = applyConfigure(settings, args ?? {})
    if (!result.ok) {
      diagnostics?.line('error', 'presence.configure_failed', { reason: result.error })
      await orca.host.call('notifications.show', {
        title: 'Discord Rich Presence',
        body: result.error
      })
      return result
    }
    if (result.changed.length === 0) {
      const view = publicConfigureView(settings)
      const hint =
        'Pass invokeCommand args: { applicationId, openUrl, showOpenButton, openButtonLabel, showAgentCount, showFocusedSurface, focusedSurfaceDetail, showAgentType, showAgentModel, showAgentProfile }. Empty applicationId restores the shipped id. HTTPS openUrl only; never put secrets in the URL.'
      const body = `applicationId=${view.shippedApplicationId ? 'shipped' : view.applicationId} openUrl=${view.openUrl || '(empty)'} showOpenButton=${view.showOpenButton} showAgentCount=${view.showAgentCount} focus=${view.showFocusedSurface} label=${view.openButtonLabel}`
      await orca.host.call('notifications.show', {
        title: 'Discord Rich Presence',
        body: `${body} ${hint}`
      })
      return { ok: true, ...view, hint, changed: [] }
    }
    await persist(result.settings)
    await refresh(undefined, { resume: true })
    const view = publicConfigureView(settings)
    diagnostics?.line('info', 'presence.configure', { changed: result.changed })
    await orca.host.call('notifications.show', {
      title: 'Discord Rich Presence',
      body: `updated ${result.changed.join(', ')}`
    })
    return { ok: true, changed: result.changed, ...view }
  })

  orca.events.on('agent.status.changed', async (payload) => {
    const parsed = parseAgentStatusPayload(payload, Date.now())
    await refresh(parsed ?? undefined)
  })
  orca.events.on('worktree.created', async () => {
    await refresh()
  })
  orca.events.on('worktree.removed', async (payload) => {
    const worktreeId = parseWorktreeRemovedId(payload)
    if (worktreeId) {
      agentTable?.removeWorktree(worktreeId)
    }
    await refresh()
  })
  orca.events.on('ui.focus.changed', async (payload) => {
    const parsed = parseUiFocusChanged(payload)
    if (!parsed) {
      return
    }
    lastFocus = parsed
    hostCaps.focus = true
    await refresh()
  })

  heartbeat = setInterval(() => {
    void refresh(undefined, { force: true })
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  settingsPoll = setInterval(() => {
    void (async () => {
      const next = await readHostSettings()
      if (!next || JSON.stringify(next) === JSON.stringify(settings)) {
        return
      }
      await persist(next)
      await refresh()
    })()
  }, SETTINGS_POLL_MS)
  settingsPoll.unref?.()

  // Why: fire-and-forget. `activate` must resolve inside
  // PLUGIN_WORKER_READY_TIMEOUT_MS (10s) or the host SIGKILLs the worker, and
  // the first refresh chains into a socket scan plus a 5s handshake timeout.
  void refresh().then(() => publishPanelSnapshot('immediate'))
}

function focusSnapshotFields(
  surface: FocusedSurfaceObject | null | undefined,
  atMs?: number
): {
  focusedSurfaceKind?: string
  focusedSurfaceTitle?: string | null
  focusedSurfaceAtMs?: number
} {
  if (surface === null) {
    return {
      focusedSurfaceKind: undefined,
      focusedSurfaceTitle: undefined,
      focusedSurfaceAtMs: undefined
    }
  }
  if (!surface) {
    return {}
  }
  return {
    focusedSurfaceKind: surface.kind,
    focusedSurfaceTitle: surface.title,
    focusedSurfaceAtMs: atMs
  }
}

/**
 * Plugin shutdown. Stops the heartbeat, clears Discord activity, and
 * closes the IPC socket. Idempotent — safe if called twice or when
 * activate never finished wiring.
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
  if (settingsPoll) {
    clearInterval(settingsPoll)
    settingsPoll = null
  }
  if (panelWriteTimer) {
    clearTimeout(panelWriteTimer)
    panelWriteTimer = null
  }
  diagnostics?.line('info', 'deactivate')
  agentTable?.clear()
  agentTable = null
  await controller?.stop()
  controller = null
  diagnostics = null
  logRing = null
}
