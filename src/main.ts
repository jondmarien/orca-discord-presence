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
import { createDiscordClient, type DiscordClient } from './discord/client'
import {
  AUTO_CLIENT,
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
  parseWorkspaceRemovedIds,
  type AgentSlot
} from './presence/agents'
import { createBridgeTransport } from './presence/bridge'
import { applyConfigure } from './presence/configure'
import { createPresenceController, type PresenceController } from './presence/controller'
import {
  buildWorkspaceLeaderboard,
  parseSessionsList,
  parseWorkspaceList,
  resolveActiveSessionStats,
  type SessionMetrics,
  type WorkspaceHostKind,
  type WorkspaceInfo
} from './presence/leaderboards'
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
 * Minimum gap between Discord client scans. Why: each scan dials up to ~240
 * sockets, so it rides the heartbeat instead of running on every event.
 */
const DETECT_MIN_INTERVAL_MS = 60_000

/**
 * Minimum gap between `workspace.list` metadata refreshes on routine events.
 */
const WORKSPACE_LIST_MIN_INTERVAL_MS = 5_000

/**
 * Cap per-workspace `agents.list({ workspaceId })` fan-out to avoid rate limits.
 */
const MAX_WORKSPACE_AGENT_FANOUT = 20

/** Concurrency cap for cross-workspace `agents.list` fan-out. */
const WORKSPACE_AGENT_CONCURRENCY = 5

/** Time budget (ms) for startup workspace/session seeding so activate() stays well inside Orca's 10s limit. */
const STARTUP_SYNC_BUDGET_MS = 2_500

/**
 * Minimum gap between `agent.listSessions` history polls when session stats or
 * Leaderboards are enabled. Never called when both are off.
 */
const SESSIONS_MIN_INTERVAL_MS = 30_000

/** Maximum sessions requested from `agent.listSessions`. */
const SESSIONS_LIST_LIMIT = 200

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

let controller: PresenceController | null = null
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
let workspacesById = new Map<string, WorkspaceInfo>()
let sessionsCache: SessionMetrics[] = []
let focusedWorkspaceId: string | undefined
let focusedHostKind: WorkspaceHostKind | undefined
let focusHandles = new Map<string, string>()
let terminalToFocusKey = new Map<string, string>()
let nextFocusHandleId = 1

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
  const currentSettings = controller.settings()
  // Why: monotonic per-terminalId handles ensure reordering or exits never
  // redirect a click from an older snapshot to a different terminal.
  const focusKeyOf = (slot: AgentSlot): string | undefined => {
    if (!slot.terminalId) {
      return undefined
    }
    let key = terminalToFocusKey.get(slot.terminalId)
    if (!key) {
      key = `a${nextFocusHandleId++}`
      terminalToFocusKey.set(slot.terminalId, key)
      focusHandles.set(key, slot.terminalId)
    }
    return key
  }
  const leaderboardRows = currentSettings.showLeaderboards
    ? buildWorkspaceLeaderboard(sessionsCache, workspacesById)
    : []
  return buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    status: controller.status(),
    settings: currentSettings,
    logs: logRing.lines(),
    timeline: persistence?.timelineSlots() ?? [],
    agents: agentTable?.slots() ?? [],
    hostKind: focusedHostKind,
    focusKeyOf,
    leaderboardRows
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
 * @param deps - Test seams; the host passes none.
 */
export default async function activate(orca: OrcaHost, deps: ActivateDeps = {}) {
  const detectClients = deps.detect ?? detectDiscordClients
  const makeDiscordClient = deps.createClient ?? createDiscordClient
  deactivated = false
  disposer = createDisposer()
  workspacesById = new Map()
  sessionsCache = []
  focusedWorkspaceId = undefined
  focusedHostKind = undefined
  focusHandles = new Map()
  terminalToFocusKey = new Map()
  nextFocusHandleId = 1
  let lastWorkspaceListAt = 0
  let lastSessionsAt = 0

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

  // Why: detection keeps socket paths; only id/label ever leave the worker.
  let detected: DetectedClient[] = []
  let lastDetectAt = 0
  async function redetect(force = false) {
    if (!force && Date.now() - lastDetectAt < DETECT_MIN_INTERVAL_MS) {
      return
    }
    lastDetectAt = Date.now()
    const found = await detectClients()
    if (deactivated) {
      return
    }
    detected = found
    // Why: a chosen client that starts after the fallback connected would never
    // get presence, since the live socket stays up. Rebuild through the same
    // path a `discordClient` change takes; the caller republishes afterwards.
    const current = settingsRuntime.current()
    const chosen = current.discordClient === AUTO_CLIENT ? undefined : found.find((client) => client.id === current.discordClient)
    const connectedPath = activeDiscord?.connectedPath() ?? null
    if (chosen && connectedPath !== null && connectedPath !== chosen.path) {
      await applySettings(current, { rebind: true })
    }
  }

  let activeDiscord: DiscordClient | null = null
  function createController(nextSettings: PresenceSettings): PresenceController {
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
      diagnostics: diagnostics ?? undefined,
      log: (message) => orca.log(message),
      onHealthChange: () => {
        publishStatusBar()
        publishPanelSnapshot('debounced')
      }
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

  persistence = await createPersistence({ host: orca.host, disposer })
  controller = createController(settingsRuntime.current())

  /**
   * Push normalized settings into the controller. A changed Application ID
   * recreates the Discord client (handshake `client_id` is fixed at construct
   * time); anything else goes through `setSettings`, which bypasses the debounce.
   *
   * Why: shared by `persist` (our own writes) and the `onDidChange` feed (edits
   * in Orca's Settings page), so both paths rebind the same way.
   */
  async function syncWorkspaces(force = false): Promise<WorkspaceInfo[]> {
    if (!orca.host.has('workspace.list')) {
      return [...workspacesById.values()]
    }
    const nowMs = Date.now()
    if (!force && lastWorkspaceListAt > 0 && nowMs - lastWorkspaceListAt < WORKSPACE_LIST_MIN_INTERVAL_MS) {
      return [...workspacesById.values()]
    }
    lastWorkspaceListAt = nowMs
    const listed = await orca.host.call('workspace.list', { includeStatus: true }).catch(() => null)
    if (deactivated || !listed) {
      return [...workspacesById.values()]
    }
    const rows = parseWorkspaceList(listed)
    const next = new Map<string, WorkspaceInfo>()
    for (const row of rows) {
      next.set(row.id, row)
    }
    workspacesById = next
    return rows
  }

  async function syncSessionsIfNeeded(force = false): Promise<void> {
    const current = settingsRuntime.current()
    if (current.showSessionStats === 'off' && !current.showLeaderboards) {
      return
    }
    if (!orca.host.has('agent.listSessions')) {
      return
    }
    const nowMs = Date.now()
    if (!force && lastSessionsAt > 0 && nowMs - lastSessionsAt < SESSIONS_MIN_INTERVAL_MS) {
      return
    }
    lastSessionsAt = nowMs
    const listed = await orca.host
      .call('agent.listSessions', { limit: SESSIONS_LIST_LIMIT })
      .catch(() => null)
    if (deactivated || !listed) {
      return
    }
    // Why: parseSessionsList discards `session.title` immediately so titles never enter memory.
    sessionsCache = parseSessionsList(listed)
    let running = 0
    let withTokens = 0
    let withMessages = 0
    for (const s of sessionsCache) {
      if (s.running) running += 1
      if (s.totalTokens > 0) withTokens += 1
      if (s.messageCount > 0) withMessages += 1
    }
    diagnostics?.line('debug', 'sessions.sync', {
      count: sessionsCache.length,
      running,
      withTokens,
      withMessages
    })
  }

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
      await syncWorkspaces(false)
      await syncSessionsIfNeeded(true)
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
      const held = !userChanged && (controller?.status().heldClear ?? false)
      await controller?.stop()
      controller = createController(nextSettings)
      if (held) {
        await controller.clear()
      } else if (!deactivated) {
        // Why: a fresh controller has published nothing, so the presence would
        // go blank until the next event or heartbeat.
        await refresh(undefined, { force: true })
      }
    } else {
      if (sessionStatsChanged && !deactivated) {
        const activeStats =
          nextSettings.showSessionStats !== 'off'
            ? resolveActiveSessionStats(agentTable?.slots() ?? [], sessionsCache, focusedWorkspaceId)
            : undefined
        // Why: merge fresh session stats silently before setSettings so Discord
        // receives exactly one SET_ACTIVITY with the updated stats.
        await controller?.update(
          { sessionTokens: activeStats?.tokens, sessionMessages: activeStats?.messages },
          { silent: true }
        )
      }
      await controller?.setSettings(nextSettings)
    }
    publishStatusBar()
    publishPanelSnapshot('immediate')
  }

  function publishStatusBar() {
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

  async function persist(nextSettings: PresenceSettings) {
    await settingsRuntime.persist(nextSettings, (next) => applySettings(next))
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
    focusedWorkspaceId = wsId
    if ((wsId && !workspacesById.has(wsId)) || options.force || settings.showLeaderboards) {
      await syncWorkspaces(false)
    }
    const wsInfo = wsId ? workspacesById.get(wsId) : undefined
    focusedHostKind = wsInfo?.hostKind
    const currentSettings = settingsRuntime.current()
    if (currentSettings.showSessionStats !== 'off' || currentSettings.showLeaderboards) {
      await syncSessionsIfNeeded(false)
    }
    const activeStats =
      currentSettings.showSessionStats !== 'off'
        ? resolveActiveSessionStats(agentTable?.slots() ?? [], sessionsCache, wsId)
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
    await controller?.update(
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
      await controller?.forceTransmit(resume)
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
    const base = controller?.status()
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
    publishStatusBar()
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
    await syncAgentsFromList({ allWorkspaces: true })
    await syncSessionsIfNeeded(true)
    // Why: a stalled Discord holds SET_ACTIVITY (and a rebind's clear) for 5s,
    // as long as the panel's request timeout. The panel sees the result on the
    // next `panels.post`. `refresh` re-reads `workspace.readContext` and force-transmits.
    void redetect(true)
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

  /**
   * Upsert every agent `agents.list` reports, which is the only source of an
   * agent's kind (`claude`, `codex`, …) and dispatched task title.
   *
   * On startup and panel Refresh (`allWorkspaces: true`), fans out across
   * active workspaces from `workspace.list({ includeStatus: true })` (capped
   * at {@link MAX_WORKSPACE_AGENT_FANOUT}) so background agents are immediately
   * visible. On unfocused `agent.status.changed`, queries that event's
   * `workspaceListId` directly. Falls back to `agents.list()` on older hosts.
   */
  const KIND_LOOKUP_ATTEMPTS = 5
  const kindAttempts = new Map<string, number>()
  const kindKnown = new Set<string>()
  function recordListedAgents(listed: unknown, workspaceListId?: string) {
    for (const seeded of parseAgentsList(listed, Date.now(), workspaceListId)) {
      if (seeded.terminalId && seeded.kind) {
        kindKnown.add(seeded.terminalId)
      }
      agentTable?.upsert(seeded)
    }
  }
  async function syncAgentsFromList(options: { workspaceId?: string; allWorkspaces?: boolean } = {}) {
    if (!orca.host.has('agents.list')) {
      return
    }
    if (options.workspaceId) {
      const listed = await orca.host
        .call('agents.list', { workspaceId: options.workspaceId })
        .catch(() => null)
      recordListedAgents(listed, options.workspaceId)
      return
    }
    if (options.allWorkspaces && orca.host.has('workspace.list')) {
      const workspaces = await syncWorkspaces(true)
      const active = workspaces
        .filter((ws) => ws.statusState !== 'inactive' || ws.terminalCount > 0)
        .slice(0, MAX_WORKSPACE_AGENT_FANOUT)
      if (active.length > 0) {
        let queried = 0
        let rateLimited = false
        for (let i = 0; i < active.length && !rateLimited; i += WORKSPACE_AGENT_CONCURRENCY) {
          if (deactivated) {
            return
          }
          const batch = active.slice(i, i + WORKSPACE_AGENT_CONCURRENCY)
          await Promise.all(
            batch.map(async (ws) => {
              if (deactivated || rateLimited) {
                return
              }
              try {
                const listed = await orca.host.call('agents.list', { workspaceId: ws.id })
                recordListedAgents(listed, ws.id)
                queried += 1
              } catch (error) {
                const code = (error as { code?: unknown } | null)?.code
                if (code === 'rate_limited') {
                  rateLimited = true
                }
              }
            })
          )
        }
        if (rateLimited) {
          diagnostics?.line('warn', 'agents.list_rate_limited', { queried, total: active.length })
        }
        if (queried > 0) {
          return
        }
      }
    }
    const listed = await orca.host.call('agents.list').catch(() => null)
    recordListedAgents(listed, focusedWorkspaceId)
  }

  orca.events.on('agent.status.changed', async (payload) => {
    const parsed = parseAgentStatusPayload(payload, Date.now())
    const terminalId = parsed?.terminalId
    if (terminalId && !kindKnown.has(terminalId)) {
      const attempts = kindAttempts.get(terminalId) ?? 0
      if (attempts < KIND_LOOKUP_ATTEMPTS) {
        kindAttempts.set(terminalId, attempts + 1)
        await syncAgentsFromList(
          parsed?.workspaceListId ? { workspaceId: parsed.workspaceListId } : {}
        )
      }
    }
    await refresh(parsed ?? undefined)
  })
  orca.events.on('workspace.removed', async (payload) => {
    const removedIds = parseWorkspaceRemovedIds(payload)
    if (removedIds.length > 0) {
      agentTable?.removeWorkspace(removedIds)
      for (const id of removedIds) {
        workspacesById.delete(id)
      }
    }
    await refresh()
  })
  orca.events.on('workspace.changed', async (payload) => {
    const raw = (payload as { context?: unknown } | null | undefined)?.context
    const context = raw && typeof raw === 'object' ? (raw as WorkspaceContext) : null
    if (context?.workspaceId) {
      focusedWorkspaceId = context.workspaceId
    }
    await syncAgentsFromList(context?.workspaceId ? { workspaceId: context.workspaceId } : {})
    await refresh(undefined, { context })
  })

  // Why: seed the table with agents already running across Orca when the worker
  // starts, bounded by STARTUP_SYNC_BUDGET_MS so slow SSH hosts never push
  // activate() past Orca's 10s ready timeout.
  const startupSeed = Promise.all([
    syncAgentsFromList({ allWorkspaces: true }),
    syncSessionsIfNeeded(true)
  ]).catch(() => {})
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    startupSeed,
    new Promise<void>((resolve) => {
      startupTimer = setTimeout(resolve, STARTUP_SYNC_BUDGET_MS)
      startupTimer.unref?.()
    })
  ])
  if (startupTimer) {
    clearTimeout(startupTimer)
  }

  settingsRuntime.watch((next) => applySettings(next))

  disposer.setInterval(() => {
    void redetect().then(() => refresh(undefined, { force: true }))
  }, HEARTBEAT_MS)

  // Why: fire-and-forget. `activate` must resolve inside
  // PLUGIN_WORKER_READY_TIMEOUT_MS (10s) or the host SIGKILLs the worker, and
  // the first refresh chains into a socket scan plus a 5s handshake timeout.
  void redetect(true)
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
  workspacesById.clear()
  sessionsCache = []
  focusedWorkspaceId = undefined
  focusedHostKind = undefined
  focusHandles.clear()
  terminalToFocusKey.clear()
  nextFocusHandleId = 1
  await controller?.stop()
  controller = null
  diagnostics = null
  logRing = null
}
