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
  detectDiscordClients,
  resolveClientCandidates,
  summarizeClients,
  type DetectedClient
} from './discord/detect'
import { defaultDiscordIpcCandidates } from './discord/ipc'
import {
  createAgentTable,
  parseAgentsList,
  parseAgentStatusPayload,
  parseWorkspaceRemovedId
} from './presence/agents'
import { applyBridgeEnvOverrides, createBridgeTransport } from './presence/bridge'
import {
  migrateSettingsToken,
  saveBridgeToken,
  SECRETS_UNAVAILABLE_WARNING,
  type TokenStore
} from './presence/bridge-token'
import { applyConfigure } from './presence/configure'
import { createPresenceController, type PresenceController } from './presence/controller'
import { createLogRing, type LogRing } from './presence/log-ring'
import { createDiagnosticSink, resolveLogFilePath, type DiagnosticSink } from './presence/log'
import { buildPresencePanelSnapshot } from './presence/panel-snapshot'
import { createTimeline, timelineStateFor } from './presence/timeline'
import {
  normalizeSettings,
  nextDetailLevel,
  SHIPPED_APPLICATION_ID,
  toggleField,
  type PresenceSettings
} from './presence/settings'
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
 * Minimum gap between Discord client scans. Why: each scan dials up to ~240
 * sockets, so it rides the heartbeat instead of running on every event.
 */
const DETECT_MIN_INTERVAL_MS = 60_000

/**
 * Coalesce `panels.post` pushes during a chatty agent event stream.
 */
const PANEL_POST_DEBOUNCE_MS = 2_000

/**
 * Quiet period before re-reading settings after `onDidChange`. Why: a multi-key
 * `persist` fires the feed once per key; this collapses them into one apply.
 */
const SETTINGS_CHANGE_DEBOUNCE_MS = 250

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
 * Command ids the panel may run through `presence.run`. Anything else (the
 * field toggles, `presence.configure`) stays palette-only.
 */
const PANEL_COMMANDS = [
  'presence.toggle',
  'presence.reload',
  'presence.clear',
  'presence.status',
  'presence.detail-level'
] as const

/**
 * Command id accepted by the `presence.run` panel handler.
 */
export type PanelCommandId = (typeof PANEL_COMMANDS)[number]

/**
 * Map a settings value to what `settings.set` accepts for a declared key.
 *
 * Why: `machineLabel` is declared `string` (default `""`) but held as `null`
 * in memory when unset; the host validates writes against the declaration and
 * would reject `null`.
 */
export function toSettingsValue(value: unknown): unknown {
  return value === null ? '' : value
}

/**
 * Error with a host-style `code`, thrown from panel handlers so the frame's
 * `plugin.request` rejects with `invalid_params` instead of a bare message.
 */
function invalidParams(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

/**
 * Payload of the host `agent.status.changed` event used by this plugin.
 *
 * `state` is an Orca agent status (`working`, `blocked`, `waiting`, `done`,
 * or an unrecognized future value). `receivedAt` is the host timestamp in
 * milliseconds; the activity builder may convert it to a Discord start
 * timestamp when `showElapsed` is on.
 */
type AgentStatusPayload = {
  state: string
  receivedAt: number
  workspaceId?: string
  terminalId?: string
  paneKey?: string
}

/**
 * Subset of `workspace.readContext` this plugin reads.
 *
 * `terminals` is only used for its length. Missing `displayName` / `branch`
 * are treated as absent by the activity builder. The `workspace.changed`
 * event carries the same shape as `{ context }`, where `context` is `null`
 * when no workspace is focused.
 */
type WorkspaceContext = {
  displayName?: string
  branch?: string
  terminals: readonly unknown[]
}

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
     * True when the connected Orca exposes `method`.
     *
     * Why: fork-only or newer host methods are guarded by this so an older
     * Orca degrades instead of throwing.
     */
    has: (method: string) => boolean
    /**
     * Invoke a host method. This plugin uses `settings.get`, `settings.set`,
     * `workspace.readContext`, `agents.list`, `notifications.show`, and the
     * `secrets.*` methods (bridge token).
     */
    call: (method: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  /** Native Settings page change feed. Absent on older hosts. */
  settings?: {
    onDidChange(handler: (e: { key: string }) => void): { dispose(): void }
  }
  /** Panel RPC channel. Absent on older hosts or browser clients. */
  panels?: {
    handle(name: string, fn: (input: unknown) => unknown): { dispose(): void }
    post(name: string, payload: unknown): void
  }
}

let controller: PresenceController | null = null
let agentTable: ReturnType<typeof createAgentTable> | null = null
let timeline: ReturnType<typeof createTimeline> | null = null
let timelineSaveTimer: ReturnType<typeof setTimeout> | null = null
let timelineHost: OrcaHost['host'] | null = null

/** Plugin storage key for the persisted 30-minute strip. */
const TIMELINE_STORAGE_KEY = 'timeline'

/**
 * Save the timeline at most every 15 s. Why: refreshes arrive on every agent
 * event; one coalesced write keeps storage churn low. Failures are ignored.
 */
function persistTimeline() {
  if (timelineSaveTimer || !timelineHost?.has('storage.set')) {
    return
  }
  timelineSaveTimer = setTimeout(() => {
    timelineSaveTimer = null
    if (timeline && timelineHost) {
      void timelineHost.call('storage.set', { key: TIMELINE_STORAGE_KEY, value: timeline.toJSON() }).catch(() => {})
    }
  }, 15_000)
  timelineSaveTimer.unref?.()
}
let heartbeat: ReturnType<typeof setInterval> | null = null
let diagnostics: DiagnosticSink | null = null
let logRing: LogRing | null = null
let panelPostTimer: ReturnType<typeof setTimeout> | null = null
let panels: OrcaHost['panels'] | null = null
let deactivated = false
let settingsChangeTimer: ReturnType<typeof setTimeout> | null = null
let settingsSubscription: { dispose(): void } | null = null

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
    showAgentCount: settings.showAgentCount
  }
}

/**
 * Redacted panel snapshot for the current controller state, or `null` before
 * `activate` finishes wiring (or after `deactivate`).
 */
function currentPanelSnapshot() {
  if (!controller || !logRing) {
    return null
  }
  return buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    status: controller.status(),
    settings: controller.settings(),
    logs: logRing.lines(),
    timeline: timeline?.slots() ?? [],
    agents: agentTable?.slots() ?? []
  })
}

/**
 * Push a redacted snapshot to the open panel with `panels.post`.
 *
 * Why: replaces the old self-rewriting `panel/index.html`. `debounced` coalesces
 * a chatty agent stream into one post per quiet window; `immediate` flushes now
 * (settings changes, palette commands). A missing `panels` (older host, browser
 * client) is a no-op and a post failure never takes down presence.
 */
function publishPanelSnapshot(mode: 'immediate' | 'debounced') {
  const flush = () => {
    panelPostTimer = null
    const snapshot = currentPanelSnapshot()
    if (!snapshot || !panels) {
      return
    }
    try {
      panels.post('presence.snapshot', snapshot)
    } catch (error) {
      diagnostics?.line('debug', 'panel.post_failed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
  if (mode === 'immediate') {
    if (panelPostTimer) {
      clearTimeout(panelPostTimer)
      panelPostTimer = null
    }
    flush()
    return
  }
  if (panelPostTimer) {
    return
  }
  panelPostTimer = setTimeout(flush, PANEL_POST_DEBOUNCE_MS)
  panelPostTimer.unref?.()
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
  const storedSettings = normalizeSettings(stored?.settings)
  // Why: the bridge token lives in secrets when the host has an OS keyring, so
  // `settings.get` alone would miss it. Merge it in before the env overlay.
  const loadedToken = await migrateSettingsToken(orca.host, storedSettings.bridgeToken)
  let tokenStore: TokenStore = loadedToken.store
  let tokenWarnings: string[] = loadedToken.warning ? [loadedToken.warning] : []
  let settings = applyBridgeEnvOverrides(
    { ...storedSettings, bridgeToken: loadedToken.token },
    process.env
  )

  const logFile = resolveLogFilePath(process.env, {
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    platform: process.platform
  })
  logRing = createLogRing()
  panels = orca.panels ?? null
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
      title: 'Rich Presence for Discord',
      body: `Invalid Discord Application ID${appId.rejectedRaw ? ` (${appId.rejectedRaw})` : ''}. Using shipped id. ${appId.reason ?? ''}`
    })
  }

  // Why: detection keeps socket paths; only id/label ever leave the worker.
  let detected: DetectedClient[] = []
  let lastDetectAt = 0
  async function redetect(force = false) {
    if (!force && Date.now() - lastDetectAt < DETECT_MIN_INTERVAL_MS) {
      return
    }
    lastDetectAt = Date.now()
    const found = await detectDiscordClients()
    if (!deactivated) {
      detected = found
    }
  }

  function createController(nextSettings: PresenceSettings): PresenceController {
    const discord = createDiscordClient({
      clientId: nextSettings.applicationId,
      candidates: () =>
        resolveClientCandidates(nextSettings.discordClient, detected, defaultDiscordIpcCandidates())
          .candidates,
      log: (message, level = 'error') => diagnostics?.line(level, 'discord.client', { reason: message })
    })
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
      diagnostics: diagnostics ?? undefined,
      log: (message) => orca.log(message)
    })
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

  timelineHost = orca.host
  // Why: restore the strip so worker restarts do not blank the last 30 minutes.
  const storedTimeline = orca.host.has('storage.get')
    ? ((await orca.host.call('storage.get', { key: TIMELINE_STORAGE_KEY }).catch(() => null)) as { value?: unknown } | null)
    : null
  timeline = createTimeline({ restore: storedTimeline?.value })
  controller = createController(settings)

  /**
   * Push normalized settings into the controller. A changed Application ID
   * recreates the Discord client (handshake `client_id` is fixed at construct
   * time); anything else goes through `setSettings`, which bypasses the debounce.
   *
   * Why: shared by `persist` (our own writes) and the `onDidChange` feed (edits
   * in Orca's Settings page), so both paths rebind the same way.
   */
  async function applySettings(nextSettings: PresenceSettings) {
    // Why: both are fixed when the Discord client is built (handshake client_id,
    // candidate list), so either change recreates it.
    const applicationIdChanged = nextSettings.applicationId !== settings.applicationId
    const clientChanged = nextSettings.discordClient !== settings.discordClient
    settings = nextSettings
    diagnostics?.setDebugEnabled(nextSettings.debugLogging)
    if (applicationIdChanged || clientChanged) {
      diagnostics?.line(
        'info',
        applicationIdChanged ? 'discord.app_id_rebind' : 'discord.client_rebind',
        applicationIdChanged
          ? { applicationId: nextSettings.applicationId }
          : { client: nextSettings.discordClient }
      )
      await controller?.stop()
      controller = createController(nextSettings)
    } else {
      await controller?.setSettings(nextSettings)
    }
    publishPanelSnapshot('immediate')
  }

  /**
   * Write changed settings fields through `settings.set`, then apply them.
   *
   * Why: unchanged keys are skipped so a toggle is one write, not sixteen, and
   * `bridgeToken` is only written when it actually changed, and then through
   * `saveBridgeToken` (secrets when available), never straight to `settings.set`.
   * Writes echo back through `onDidChange`; the re-read then equals `settings`,
   * so the echo applies nothing new.
   */
  async function persist(nextSettings: PresenceSettings) {
    const previous = settings
    for (const [key, value] of Object.entries(nextSettings)) {
      if (previous[key as keyof PresenceSettings] === value) {
        continue
      }
      const write =
        key === 'bridgeToken'
          ? saveBridgeToken(orca.host, String(value)).then((store) => {
              tokenStore = store
              tokenWarnings = store === 'settings' ? [SECRETS_UNAVAILABLE_WARNING] : []
            })
          : orca.host.call('settings.set', { key, value: toSettingsValue(value) })
      await write.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        orca.log(`failed to persist ${key}: ${message}`)
      })
    }
    await applySettings(nextSettings)
  }

  /**
   * Merge workspace context and the agent table into the controller.
   *
   * A missing `workspace.readContext` used to return without `update`, so
   * generic “Working in Orca” never appeared. We still publish a minimal
   * snapshot (`machineName` + optional agent fields) in that case.
   */
  async function refresh(
    agentEvent?: AgentStatusPayload | null,
    options: { force?: boolean; resume?: boolean; context?: WorkspaceContext | null } = {}
  ) {
    if (agentEvent) {
      const parsed = parseAgentStatusPayload(agentEvent, Date.now())
      if (parsed) {
        agentTable?.upsert(parsed)
      }
    }
    const summary = agentTable?.summarize() ?? {
      agentCount: 0,
      agentState: undefined,
      stateStartedAtMs: undefined
    }
    // Why: `workspace.changed` already carries the context (possibly null for
    // "nothing focused"), so use it instead of a second host round trip.
    const context =
      options.context !== undefined
        ? options.context
        : ((await orca.host.call('workspace.readContext').catch(() => null)) as WorkspaceContext | null)
    if (!context) {
      diagnostics?.line('debug', 'refresh.minimal', {
        reason: 'no workspace context',
        agents: summary.agentCount
      })
    } else if (agentEvent) {
      diagnostics?.line('debug', 'refresh', {
        source: 'agent.status.changed',
        agentState: summary.agentState ?? 'idle',
        agents: summary.agentCount
      })
    }
    const resume = Boolean(options.resume || agentEvent)
    await controller?.update(
      {
        machineName: os.hostname(),
        ...(context
          ? {
              displayName: context.displayName,
              branch: context.branch,
              terminalCount: Array.isArray(context.terminals) ? context.terminals.length : undefined
            }
          : {}),
        agentState: summary.agentState,
        stateStartedAtMs: summary.stateStartedAtMs,
        agentCount: summary.agentCount
      },
      resume ? { resume: true } : undefined
    )
    if (options.force) {
      await controller?.forceTransmit(resume)
    }
    // Why: `done` is recorded as `completed`; no agents at all is `idle`.
    timeline?.record(timelineStateFor(summary.agentState))
    persistTimeline()
    publishPanelSnapshot('debounced')
  }

  pushAgentRefresh = () => {
    void refresh()
  }

  const paletteHandlers = new Map<string, () => Promise<unknown>>()
  const registerPalette = (id: string, handler: () => Promise<unknown>) => {
    paletteHandlers.set(id, handler)
    orca.commands.register(id, handler)
  }

  registerPalette('presence.toggle', async () => {
    await persist({ ...settings, enabled: !settings.enabled })
    await refresh()
    return { enabled: settings.enabled }
  })

  registerPalette('presence.detail-level', async () => {
    await persist({ ...settings, detailLevel: nextDetailLevel(settings.detailLevel) })
    await refresh()
    return { detailLevel: settings.detailLevel }
  })

  for (const [commandId, field] of Object.entries(TOGGLE_COMMANDS) as [
    ToggleCommandId,
    (typeof TOGGLE_COMMANDS)[ToggleCommandId]
  ][]) {
    registerPalette(commandId, async () => {
      await persist(toggleField(settings, field))
      await refresh()
      return { [field]: settings[field] }
    })
  }

  registerPalette('presence.status', async () => {
    await refresh(undefined, { force: true, resume: true })
    const base = controller?.status()
    const status = base
      ? { ...base, bridgeTokenStore: tokenStore, ...(tokenWarnings.length > 0 ? { warnings: tokenWarnings } : {}) }
      : undefined
    const file = status?.logFile ?? diagnostics?.filePath ?? ''
    const transmitting = formatStatusTransmitting(status?.lastActivity ?? null)
    const warned = tokenWarnings.length > 0 ? ` warnings=${tokenWarnings.join('; ')}` : ''
    const summary = `enabled=${status?.enabled} connected=${status?.connected} client=${status?.client?.id ?? 'none'} sink=${status?.sink} bridge=${status?.bridgeEnabled} tokenStore=${tokenStore} detail=${status?.detailLevel} debug=${settings.debugLogging}${warned}`
    diagnostics?.line('info', 'status', {
      enabled: status?.enabled,
      connected: status?.connected,
      client: status?.client?.id ?? 'none',
      sink: status?.sink,
      bridge: status?.bridgeEnabled,
      tokenStore,
      warnings: tokenWarnings,
      detail: status?.detailLevel,
      debug: settings.debugLogging,
      file,
      transmitting: JSON.stringify(status?.lastActivity)
    })
    await orca.host.call('notifications.show', {
      title: 'Rich Presence for Discord',
      body: `${summary} ${transmitting}`
    })
    publishPanelSnapshot('immediate')
    return status
  })

  registerPalette('presence.reload', async () => {
    await redetect(true)
    await refresh()
    diagnostics?.line('info', 'discord.reload_command')
    await controller?.reload()
    const status = controller?.status()
    const transmitting = formatStatusTransmitting(status?.lastActivity ?? null)
    const summary = `reloaded connected=${status?.connected} client=${status?.client?.id ?? 'none'} sink=${status?.sink} ${transmitting}`
    diagnostics?.line('info', 'discord.reload_done', {
      connected: status?.connected,
      sink: status?.sink,
      transmitting: JSON.stringify(status?.lastActivity)
    })
    await orca.host.call('notifications.show', {
      title: 'Rich Presence for Discord',
      body: summary
    })
    publishPanelSnapshot('immediate')
    return status
  })

  registerPalette('presence.clear', async () => {
    diagnostics?.line('info', 'discord.clear_command')
    await controller?.clear()
    const status = controller?.status()
    const summary = `cleared enabled=${status?.enabled} heldClear=${status?.heldClear} sink=${status?.sink}`
    diagnostics?.line('info', 'discord.clear_done', {
      enabled: status?.enabled,
      heldClear: status?.heldClear,
      sink: status?.sink
    })
    await orca.host.call('notifications.show', {
      title: 'Rich Presence for Discord',
      body: `${summary} Presence is cleared until the next agent event, Show Status, Reload RPC, or a settings change. enabled stays on.`
    })
    publishPanelSnapshot('immediate')
    return status
  })

  orca.commands.register('presence.configure', async (args) => {
    const result = applyConfigure(settings, args ?? {})
    if (!result.ok) {
      diagnostics?.line('error', 'presence.configure_failed', { reason: result.error })
      await orca.host.call('notifications.show', {
        title: 'Rich Presence for Discord',
        body: result.error
      })
      return result
    }
    if (result.changed.length === 0) {
      const view = publicConfigureView(settings)
      const hint =
        'Pass invokeCommand args: { applicationId, openUrl, showOpenButton, openButtonLabel, showAgentCount, bridgeToken }. Empty applicationId restores the shipped id. HTTPS openUrl only; never put secrets in the URL.'
      const body = `applicationId=${view.shippedApplicationId ? 'shipped' : view.applicationId} openUrl=${view.openUrl || '(empty)'} showOpenButton=${view.showOpenButton} showAgentCount=${view.showAgentCount} label=${view.openButtonLabel}`
      await orca.host.call('notifications.show', {
        title: 'Rich Presence for Discord',
        body: `${body} ${hint}`
      })
      return { ok: true, ...view, hint, changed: [] }
    }
    await persist(result.settings)
    await refresh(undefined, { resume: true })
    const view = publicConfigureView(settings)
    diagnostics?.line('info', 'presence.configure', { changed: result.changed })
    await orca.host.call('notifications.show', {
      title: 'Rich Presence for Discord',
      body: `updated ${result.changed.join(', ')}`
    })
    return { ok: true, changed: result.changed, ...view }
  })

  // Why: the panel talks to the worker through `plugin.request`. Guarded:
  // older hosts and browser clients have no `orca.panels`, and the panel shows
  // its static "needs Orca desktop" note there.
  panels?.handle('presence.snapshot', () => currentPanelSnapshot())
  panels?.handle('presence.run', async (input) => {
    const command = (input as { command?: unknown } | null | undefined)?.command
    if (typeof command !== 'string' || !(PANEL_COMMANDS as readonly string[]).includes(command)) {
      throw invalidParams(`presence.run command must be one of: ${PANEL_COMMANDS.join(', ')}`)
    }
    try {
      await paletteHandlers.get(command)?.()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * Upsert every agent `agents.list` reports, which is the only source of an
   * agent's kind (`claude`, `codex`, …).
   *
   * Why: `agent.status.changed` carries no kind, and `agents.list` covers only
   * the focused workspace and can answer before a brand-new agent is listed.
   * So a terminal whose kind is still unknown is looked up again on its next
   * events (at most {@link KIND_LOOKUP_ATTEMPTS} times), and every focus change
   * re-syncs. Guarded: older Orca and browser clients lack `agents.list`.
   */
  const KIND_LOOKUP_ATTEMPTS = 5
  const kindAttempts = new Map<string, number>()
  const kindKnown = new Set<string>()
  async function syncAgentsFromList() {
    if (!orca.host.has('agents.list')) {
      return
    }
    const listed = await orca.host.call('agents.list').catch(() => null)
    for (const seeded of parseAgentsList(listed, Date.now())) {
      if (seeded.terminalId && seeded.kind) {
        kindKnown.add(seeded.terminalId)
      }
      agentTable?.upsert(seeded)
    }
  }

  orca.events.on('agent.status.changed', async (payload) => {
    const parsed = parseAgentStatusPayload(payload, Date.now())
    const terminalId = parsed?.terminalId
    if (terminalId && !kindKnown.has(terminalId)) {
      const attempts = kindAttempts.get(terminalId) ?? 0
      if (attempts < KIND_LOOKUP_ATTEMPTS) {
        kindAttempts.set(terminalId, attempts + 1)
        await syncAgentsFromList()
      }
    }
    await refresh(parsed ?? undefined)
  })
  orca.events.on('workspace.removed', async (payload) => {
    const workspaceId = parseWorkspaceRemovedId(payload)
    if (workspaceId) {
      agentTable?.removeWorkspace(workspaceId)
    }
    await refresh()
  })
  orca.events.on('workspace.changed', async (payload) => {
    const raw = (payload as { context?: unknown } | null | undefined)?.context
    const context = raw && typeof raw === 'object' ? (raw as WorkspaceContext) : null
    // Why: agents.list answers for the focused workspace only, so a focus change
    // is when kinds and titles of that workspace's agents become readable.
    await syncAgentsFromList()
    await refresh(undefined, { context })
  })

  // Why: seed the table with agents already running when the worker starts,
  // so presence is right before the next status event. Guarded: older Orca and
  // browser clients lack `agents.list`.
  await syncAgentsFromList()

  // Why: the person can edit settings in Orca's Settings page while the worker
  // runs. Re-read and apply without a reload. Debounced so a multi-key
  // `persist` (each `settings.set` fires the feed) applies at most once.
  // Guarded: older hosts have no `orca.settings`.
  if (orca.settings?.onDidChange) {
    settingsSubscription = orca.settings.onDidChange(() => {
      if (settingsChangeTimer) {
        clearTimeout(settingsChangeTimer)
      }
      settingsChangeTimer = setTimeout(() => {
        settingsChangeTimer = null
        void (async () => {
          const latest = (await orca.host.call('settings.get').catch(() => null)) as {
            settings?: unknown
          } | null
          if (deactivated || !latest) {
            return
          }
          // Why: a settings re-read carries no secrets-held token; merge it
          // back so an unrelated edit never wipes it before the env overlay.
          const reread = normalizeSettings(latest.settings)
          const reloadedToken = await migrateSettingsToken(orca.host, reread.bridgeToken)
          tokenStore = reloadedToken.store
          tokenWarnings = reloadedToken.warning ? [reloadedToken.warning] : []
          const next = applyBridgeEnvOverrides(
            { ...reread, bridgeToken: reloadedToken.token },
            process.env
          )
          if (JSON.stringify(next) !== JSON.stringify(settings)) {
            await applySettings(next)
          }
        })()
      }, SETTINGS_CHANGE_DEBOUNCE_MS)
      settingsChangeTimer.unref?.()
    })
  }

  heartbeat = setInterval(() => {
    void redetect().then(() => refresh(undefined, { force: true }))
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  // Why: fire-and-forget. `activate` must resolve inside
  // PLUGIN_WORKER_READY_TIMEOUT_MS (10s) or the host SIGKILLs the worker, and
  // the first refresh chains into a socket scan plus a 5s handshake timeout.
  void redetect(true)
    .then(() => refresh())
    .then(() => {
      publishPanelSnapshot('immediate')
    })
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
  if (panelPostTimer) {
    clearTimeout(panelPostTimer)
    panelPostTimer = null
  }
  if (timelineSaveTimer) {
    clearTimeout(timelineSaveTimer)
    timelineSaveTimer = null
  }
  // Why: flush the strip on a clean stop so the next start restores it.
  if (timeline && timelineHost?.has('storage.set')) {
    await timelineHost.call('storage.set', { key: TIMELINE_STORAGE_KEY, value: timeline.toJSON() }).catch(() => {})
  }
  panels = null
  if (settingsChangeTimer) {
    clearTimeout(settingsChangeTimer)
    settingsChangeTimer = null
  }
  settingsSubscription?.dispose()
  settingsSubscription = null
  diagnostics?.line('info', 'deactivate')
  agentTable?.clear()
  agentTable = null
  await controller?.stop()
  controller = null
  diagnostics = null
  logRing = null
}
