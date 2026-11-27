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
import {
  createAgentTable,
  parseAgentStatusPayload,
  parseWorkspaceRemovedIds,
  type AgentSlot
} from './presence/agents'
import { applyConfigure } from './presence/configure'
import { buildWorkspaceLeaderboard, resolveActiveSessionStats } from './presence/leaderboards'
import { createLogRing, type LogRing } from './presence/log-ring'
import { createDiagnosticSink, resolveLogFilePath, type DiagnosticSink } from './presence/log'
import type { CanonicalAgentState } from './presence/agent-state'
import { buildPresencePanelSnapshot } from './presence/panel-snapshot'
import { timelineStateFor } from './presence/timeline'
import {
  nextDetailLevel,
  SHIPPED_APPLICATION_ID,
  toggleField,
  type PresenceSettings
} from './presence/settings'
import { PLUGIN_VERSION } from './version'
import { createDiscordBinding, type DiscordBinding } from './worker/discord-binding'
import {
  createDisposer,
  invalidParams,
  toSettingsValue,
  type ActivateDeps,
  type AgentStatusPayload,
  type Disposer,
  type OrcaHost,
  type WorkspaceContext
} from './worker/host'
import { createHostSync, type HostSync } from './worker/host-sync'
import { createPersistence, type WorkerPersistence } from './worker/persistence'
import { createSettingsRuntime } from './worker/settings-runtime'

export { toSettingsValue, type ActivateDeps, type OrcaHost }

/**
 * Interval for the `workspace.readContext` heartbeat.
 *
 * Why: the worker is reaped after `PLUGIN_WORKER_IDLE_REAP_MS` (5 min) of no
 * host calls. This poll both refreshes that clock and catches branch
 * switches, which emit no event.
 */
const HEARTBEAT_MS = 90_000

/**
 * Coalesce `panels.post` pushes during a chatty agent event stream.
 */
const PANEL_POST_DEBOUNCE_MS = 2_000

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

let binding: DiscordBinding | null = null
let hostSync: HostSync | null = null
let agentTable: ReturnType<typeof createAgentTable> | null = null
let persistence: WorkerPersistence | null = null
let disposer: Disposer | null = null
let latestSummary: { agentState: CanonicalAgentState | undefined; agentCount: number; stateStartedAtMs?: number } = {
  agentState: undefined,
  agentCount: 0
}
let diagnostics: DiagnosticSink | null = null
let logRing: LogRing | null = null
let panelPostTimer: ReturnType<typeof setTimeout> | null = null
let panels: OrcaHost['panels'] | null = null
let deactivated = false
let focusHandles = new Map<string, string>()

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
  const controller = binding?.controller()
  if (!controller || !logRing) {
    return null
  }
  const currentSettings = controller.settings()
  const nextHandles = new Map<string, string>()
  let handleIndex = 0
  const focusKeyOf = (slot: AgentSlot): string | undefined => {
    if (!slot.terminalId) {
      return undefined
    }
    const key = `a${handleIndex++}`
    nextHandles.set(key, slot.terminalId)
    return key
  }
  const leaderboardRows =
    currentSettings.showLeaderboards && hostSync
      ? buildWorkspaceLeaderboard(hostSync.sessions(), hostSync.workspaces())
      : []
  const snapshot = buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    status: controller.status(),
    settings: currentSettings,
    logs: logRing.lines(),
    timeline: persistence?.timelineSlots() ?? [],
    agents: agentTable?.slots() ?? [],
    hostKind: hostSync?.focusedHostKind(),
    focusKeyOf,
    leaderboardRows
  })
  focusHandles = nextHandles
  return snapshot
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
 * @param deps - Test seams; the host passes none.
 */
export default async function activate(orca: OrcaHost, deps: ActivateDeps = {}) {
  deactivated = false
  disposer = createDisposer()
  focusHandles = new Map()

  const settingsRuntime = await createSettingsRuntime({ orca, disposer })
  const appId = settingsRuntime.appIdInspection

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
    debugEnabled: settingsRuntime.current().debugLogging,
    onEmit: (line) => {
      logRing?.push(line)
    }
  })
  diagnostics.line('info', 'activate', {
    version: PLUGIN_VERSION,
    debug: settingsRuntime.current().debugLogging,
    file: logFile,
    bridge: settingsRuntime.current().bridgeEnabled
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

  let pushAgentRefresh: () => void = () => {}
  agentTable = createAgentTable({
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    },
    onChange: () => {
      hostSync?.pruneKindCache()
      pushAgentRefresh()
    }
  })

  persistence = await createPersistence({ host: orca.host, disposer })
  hostSync = createHostSync({ host: orca.host, agentTable, disposer, diagnostics })

  function publishStatusBar() {
    const controller = binding?.controller()
    if (!controller || !persistence) {
      return
    }
    persistence.publishStatusBar({
      status: controller.status(),
      settings: controller.settings(),
      agentState: latestSummary.agentState,
      agentCount: latestSummary.agentCount,
      stateStartedAtMs: latestSummary.stateStartedAtMs
    })
  }

  binding = createDiscordBinding({
    settingsRuntime,
    disposer,
    diagnostics,
    log: (message) => orca.log(message),
    detectClients: deps.detect,
    makeDiscordClient: deps.createClient,
    onHealthChange: () => {
      publishStatusBar()
      publishPanelSnapshot('debounced')
    },
    onNeedsHistory: async () => {
      await hostSync?.syncWorkspaces(false)
      await hostSync?.syncSessionsIfNeeded(settingsRuntime.current(), true)
    },
    onRepublish: async (opts) => {
      await refresh(undefined, opts)
    },
    onAfterApply: () => {
      publishStatusBar()
      publishPanelSnapshot('immediate')
    }
  })

  async function persist(nextSettings: PresenceSettings) {
    await settingsRuntime.persist(nextSettings, (next) => binding!.applySettings(next))
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
    options: { force?: boolean; resume?: boolean; context?: WorkspaceContext | null; startup?: boolean } = {}
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
    latestSummary = summary
    // Why: `workspace.changed` already carries the context (possibly null for
    // "nothing focused"), so use it instead of a second host round trip.
    const context =
      options.context !== undefined
        ? options.context
        : ((await orca.host.call('workspace.readContext').catch(() => null)) as WorkspaceContext | null)
    const wsId = typeof context?.workspaceId === 'string' && context.workspaceId.length > 0 ? context.workspaceId : undefined
    const wsInfo = await hostSync?.resolveFocusedWorkspace(wsId)
    const currentSettings = settingsRuntime.current()
    await hostSync?.syncSessionsIfNeeded(currentSettings, false)
    const activeStats =
      currentSettings.showSessionStats !== 'off' && hostSync
        ? resolveActiveSessionStats(agentTable?.slots() ?? [], hostSync.sessions(), wsId)
        : undefined
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
    // Why: only real activity extends a session; the bare heartbeat must not, or an
    // idle Orca would never end its session. Startup with an open workspace counts.
    if (agentEvent || options.context !== undefined || summary.agentCount > 0 || (options.startup && context)) {
      persistence?.touchSessionOnly()
    }
    const resume = Boolean(options.resume || agentEvent)
    await binding?.controller().update(
      {
        machineName: os.hostname(),
        ...(context
          ? {
              displayName: context.displayName,
              projectName: wsInfo?.project,
              branch: context.branch,
              terminalCount: Array.isArray(context.terminals) ? context.terminals.length : undefined
            }
          : // Why: the controller merges snapshots, so omitted keys would keep the
            // previous workspace on Discord after focus moves to nothing.
            { displayName: undefined, projectName: undefined, branch: undefined, terminalCount: undefined }),
        agentState: summary.agentState,
        stateStartedAtMs: summary.stateStartedAtMs,
        sessionStartMs: persistence?.sessionStartMs(),
        agentCount: summary.agentCount,
        sessionTokens: activeStats?.tokens,
        sessionMessages: activeStats?.messages
      },
      resume ? { resume: true } : undefined
    )
    if (options.force) {
      await binding?.controller().forceTransmit(resume)
    }
    // Why: every agent's state is recorded, so a minute with one working and
    // two completed agents shows both. `done` is recorded as `completed`; no
    // agents at all records `[]`, which is `idle`.
    persistence?.recordTimeline((agentTable?.slots() ?? []).map((slot) => timelineStateFor(slot.canonicalState)))
    persistence?.scheduleSave()
    publishStatusBar()
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
    const current = settingsRuntime.current()
    await persist({ ...current, enabled: !current.enabled })
    await refresh()
    publishStatusBar()
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
    const base = binding?.controller().status()
    const tokenStore = settingsRuntime.tokenStore()
    const tokenWarnings = settingsRuntime.tokenWarnings()
    const current = settingsRuntime.current()
    const status = base
      ? { ...base, bridgeTokenStore: tokenStore, ...(tokenWarnings.length > 0 ? { warnings: tokenWarnings } : {}) }
      : undefined
    const file = status?.logFile ?? diagnostics?.filePath ?? ''
    const transmitting = formatStatusTransmitting(status?.lastActivity ?? null)
    const warned = tokenWarnings.length > 0 ? ` warnings=${tokenWarnings.join('; ')}` : ''
    const summary = `enabled=${status?.enabled} connected=${status?.connected} client=${status?.client?.id ?? 'none'} sink=${status?.sink} bridge=${status?.bridgeEnabled} tokenStore=${tokenStore} detail=${status?.detailLevel} debug=${current.debugLogging}${warned}`
    diagnostics?.line('info', 'status', {
      enabled: status?.enabled,
      connected: status?.connected,
      client: status?.client?.id ?? 'none',
      sink: status?.sink,
      bridge: status?.bridgeEnabled,
      tokenStore,
      warnings: tokenWarnings,
      detail: status?.detailLevel,
      debug: current.debugLogging,
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
    const { rebound } = (await binding?.redetect(true)) ?? { rebound: false }
    diagnostics?.line('info', 'discord.reload_command')
    if (!rebound || binding?.controller().status().heldClear) {
      await refresh()
      await binding?.controller().reload()
    }
    const status = binding?.controller().status()
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
    await binding?.controller().clear()
    publishStatusBar()
    const status = binding?.controller().status()
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
    const result = applyConfigure(settingsRuntime.current(), args ?? {})
    if (!result.ok) {
      diagnostics?.line('error', 'presence.configure_failed', { reason: result.error })
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
      diagnostics?.line('error', 'presence.configure_failed', { reason: message })
      await orca.host.call('notifications.show', {
        title: 'Rich Presence for Discord',
        body: `Could not save: ${message}`
      })
      return { ok: false, error: message, message }
    }
    await refresh(undefined, { resume: true })
    const view = publicConfigureView(settingsRuntime.current())
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
  panels?.handle('presence.snapshot', () => {
    // Why: opening the panel can start a new session; refresh so Discord and storage get it.
    if (persistence?.touchSession()) {
      void refresh()
    }
    return currentPanelSnapshot()
  })

  // Why: the panel's Refresh button forces a full resync (agents, focused
  // workspace, Discord clients). The rate limit keeps a mashed button from
  // probing sockets repeatedly; a call inside the window just answers with the
  // current snapshot.
  const PANEL_REFRESH_MIN_MS = 2000
  let lastPanelRefreshAt = 0
  panels?.handle('presence.refresh', async () => {
    const clock = Date.now()
    if (clock - lastPanelRefreshAt < PANEL_REFRESH_MIN_MS) {
      return currentPanelSnapshot()
    }
    lastPanelRefreshAt = clock
    persistence?.touchSession()
    await hostSync?.syncAgentsFromList({ allWorkspaces: true })
    await hostSync?.syncSessionsIfNeeded(settingsRuntime.current(), true)
    // Why: a stalled Discord holds SET_ACTIVITY (and a rebind's clear) for 5s,
    // as long as the panel's request timeout. The panel sees the result on the
    // next `panels.post`. `refresh` re-reads `workspace.readContext` and force-transmits.
    void binding
      ?.redetect(true)
      .then(() => refresh(undefined, { force: true }))
      .catch((error) =>
        diagnostics?.line('error', 'panel.refresh_failed', {
          reason: error instanceof Error ? error.message : String(error)
        })
      )
    return currentPanelSnapshot()
  })
  panels?.handle('presence.focus-agent', async (input) => {
    const key = (input as { key?: unknown } | null | undefined)?.key
    if (typeof key !== 'string' || key.length === 0) {
      throw invalidParams('presence.focus-agent requires a non-empty key')
    }
    const terminalId = focusHandles.get(key)
    if (!terminalId) {
      return { ok: false, focused: false }
    }
    if (!orca.host.has('terminal.focus')) {
      return { ok: false, focused: false }
    }
    try {
      const result = (await orca.host.call('terminal.focus', { terminalId })) as { focused?: unknown } | null
      return { ok: true, focused: Boolean(result?.focused) }
    } catch (error) {
      return { ok: false, focused: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
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

  orca.events.on('agent.status.changed', async (payload) => {
    const parsed = parseAgentStatusPayload(payload, Date.now())
    await hostSync?.ensureAgentKind(parsed?.terminalId, parsed?.workspaceListId)
    await refresh(parsed ?? undefined)
  })
  orca.events.on('workspace.removed', async (payload) => {
    const removedIds = parseWorkspaceRemovedIds(payload)
    if (removedIds.length > 0) {
      agentTable?.removeWorkspace(removedIds)
      hostSync?.removeWorkspaces(removedIds)
    }
    await refresh()
  })
  orca.events.on('workspace.changed', async (payload) => {
    const raw = (payload as { context?: unknown } | null | undefined)?.context
    const context = raw && typeof raw === 'object' ? (raw as WorkspaceContext) : null
    hostSync?.setFocusedWorkspaceId(context?.workspaceId)
    await hostSync?.syncAgentsFromList(context?.workspaceId ? { workspaceId: context.workspaceId } : {})
    await refresh(undefined, { context })
  })

  // Why: seed the table with agents already running across Orca when the worker
  // starts, so presence is right before the next status event.
  await hostSync.syncAgentsFromList({ allWorkspaces: true })
  await hostSync.syncSessionsIfNeeded(settingsRuntime.current(), true)

  settingsRuntime.watch((next) => binding!.applySettings(next))

  disposer.setInterval(() => {
    void binding?.redetect().then(() => refresh(undefined, { force: true }))
  }, HEARTBEAT_MS)

  // Why: fire-and-forget. `activate` must resolve inside
  // PLUGIN_WORKER_READY_TIMEOUT_MS (10s) or the host SIGKILLs the worker, and
  // the first refresh chains into a socket scan plus a 5s handshake timeout.
  void binding
    .redetect(true)
    .then(() => refresh(undefined, { startup: true }))
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
  if (panelPostTimer) {
    clearTimeout(panelPostTimer)
    panelPostTimer = null
  }
  disposer?.disposeAll()
  disposer = null
  await persistence?.flush()
  persistence = null
  panels = null
  diagnostics?.line('info', 'deactivate')
  agentTable?.clear()
  agentTable = null
  hostSync?.clear()
  hostSync = null
  focusHandles.clear()
  await binding?.stop()
  binding = null
  diagnostics = null
  logRing = null
}
