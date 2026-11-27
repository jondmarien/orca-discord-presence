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
import { applyBridgeEnvOverrides, createBridgeTransport } from './presence/bridge'
import {
  migrateSettingsToken,
  saveBridgeToken,
  SECRETS_UNAVAILABLE_WARNING,
  type TokenStore
} from './presence/bridge-token'
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
import { elapsedStartMs } from './presence/activity'
import type { CanonicalAgentState } from './presence/agent-state'
import { SESSION_GAP_MS } from './presence/expiry'
import { buildPresencePanelSnapshot } from './presence/panel-snapshot'
import { createSessionClock, type SessionClock } from './presence/session'
import { renderStatusBar } from './presence/status-bar'
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
  workspaceId?: string | null
  workspaceListId?: string
  terminalId?: string
  sessionId?: string
  paneKey?: string
  title?: string
  mainAgent?: {
    state?: string
    outcome?: string
    stateStartedAt?: number
  }
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
  workspaceId?: string
  displayName?: string
  branch?: string
  terminals: readonly unknown[]
}

/**
 * Host object Orca injects into `activate`. Aligned with Orca 1.4.278
 * `OrcaWorkerApi` (`orca/worker`) while staying standalone for CI typechecks.
 */
export type OrcaHost = {
  /** Host API version when supplied by Orca (`{ major: 1, minor: 10 }` on 1.4.278). */
  readonly api?: { readonly major: number; readonly minor: number }
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
     * Why: newer host methods are guarded by this so an older Orca degrades
     * cleanly instead of throwing.
     */
    has: (method: string) => boolean
    /**
     * Invoke a host method (`settings.*`, `storage.*`, `secrets.*`,
     * `workspace.readContext`, `workspace.list`, `agents.list`,
     * `terminal.focus`, `agent.listSessions`, `statusBar.update`,
     * `notifications.show`).
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
let session: SessionClock | null = null
let lastStatusBar: string | null = null
let latestSummary: { agentState: CanonicalAgentState | undefined; agentCount: number; stateStartedAtMs?: number } = {
  agentState: undefined,
  agentCount: 0
}

/** Plugin storage key for the persisted 30-minute strip. */
const TIMELINE_STORAGE_KEY = 'timeline'

/** Plugin storage key for the persisted session clock. */
const SESSION_STORAGE_KEY = 'session'

/**
 * Write the timeline and session clock to plugin storage. Failures are ignored.
 */
function flushState(host: OrcaHost['host']) {
  if (timeline) {
    void host.call('storage.set', { key: TIMELINE_STORAGE_KEY, value: timeline.toJSON() }).catch(() => {})
  }
  const sessionState = session?.toJSON()
  if (sessionState) {
    void host.call('storage.set', { key: SESSION_STORAGE_KEY, value: sessionState }).catch(() => {})
  }
}

/**
 * Save the timeline and session at most every 15 s. Why: refreshes arrive on
 * every agent event; one coalesced write keeps storage churn low.
 */
function persistState() {
  if (timelineSaveTimer || !timelineHost?.has('storage.set')) {
    return
  }
  timelineSaveTimer = setTimeout(() => {
    timelineSaveTimer = null
    if (timelineHost) {
      flushState(timelineHost)
    }
  }, 15_000)
  timelineSaveTimer.unref?.()
}
/**
 * Touch the session clock from a panel request and schedule a save.
 *
 * @returns True when the touch started a new session (the start moved).
 */
function touchSession(): boolean {
  const before = session?.startMs()
  session?.touch()
  persistState()
  return session?.startMs() !== before
}

let heartbeat: ReturnType<typeof setInterval> | null = null
let diagnostics: DiagnosticSink | null = null
let logRing: LogRing | null = null
let panelPostTimer: ReturnType<typeof setTimeout> | null = null
let panels: OrcaHost['panels'] | null = null
let deactivated = false
let settingsChangeTimer: ReturnType<typeof setTimeout> | null = null
let settingsSubscription: { dispose(): void } | null = null
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
    timeline: timeline?.slots() ?? [],
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

/** Test seams for {@link activate}: Discord detection and client construction. */
export type ActivateDeps = {
  detect?: typeof detectDiscordClients
  createClient?: typeof createDiscordClient
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
  workspacesById = new Map()
  sessionsCache = []
  focusedWorkspaceId = undefined
  focusedHostKind = undefined
  focusHandles = new Map()
  terminalToFocusKey = new Map()
  nextFocusHandleId = 1
  let lastWorkspaceListAt = 0
  let lastSessionsAt = 0
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
    const found = await detectClients()
    if (deactivated) {
      return
    }
    detected = found
    // Why: a chosen client that starts after the fallback connected would never
    // get presence, since the live socket stays up. Rebuild through the same
    // path a `discordClient` change takes; the caller republishes afterwards.
    const chosen = settings.discordClient === AUTO_CLIENT ? undefined : found.find((client) => client.id === settings.discordClient)
    const connectedPath = activeDiscord?.connectedPath() ?? null
    if (chosen && connectedPath !== null && connectedPath !== chosen.path) {
      await applySettings(settings, { rebind: true })
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

  timelineHost = orca.host
  // Why: restore the strip so worker restarts do not blank the last 30 minutes.
  const storedTimeline = orca.host.has('storage.get')
    ? ((await orca.host.call('storage.get', { key: TIMELINE_STORAGE_KEY }).catch(() => null)) as { value?: unknown } | null)
    : null
  timeline = createTimeline({ restore: storedTimeline?.value })
  // Why: restoring keeps the session start across worker and Orca restarts inside the gap.
  const storedSession = orca.host.has('storage.get')
    ? ((await orca.host.call('storage.get', { key: SESSION_STORAGE_KEY }).catch(() => null)) as { value?: unknown } | null)
    : null
  session = createSessionClock({ gapMs: SESSION_GAP_MS })
  session.restore(storedSession?.value)
  lastStatusBar = null
  controller = createController(settings)

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
    if (settings.showSessionStats === 'off' && !settings.showLeaderboards) {
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
    // Why: both are fixed when the Discord client is built (handshake client_id,
    // candidate list), so either change recreates it.
    const applicationIdChanged = nextSettings.applicationId !== settings.applicationId
    const clientChanged = nextSettings.discordClient !== settings.discordClient
    const sessionStatsChanged = nextSettings.showSessionStats !== settings.showSessionStats
    const needsHistoryNow =
      (nextSettings.showLeaderboards && !settings.showLeaderboards) ||
      (sessionStatsChanged && nextSettings.showSessionStats !== 'off')
    settings = nextSettings
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

  /**
   * Send the status bar item to the host when its rendered fields changed.
   *
   * Why: the item mirrors the same privacy-gated status as the Discord card,
   * and skipping unchanged patches keeps host calls off the hot path.
   */
  function publishStatusBar() {
    if (!orca.host.has('statusBar.update') || !controller) {
      return
    }
    const currentSettings = controller.settings()
    const patch = renderStatusBar({
      status: controller.status(),
      settings: currentSettings,
      agentState: latestSummary.agentState,
      agentCount: latestSummary.agentCount,
      elapsedStartMs: elapsedStartMs(
        { sessionStartMs: session?.startMs(), stateStartedAtMs: latestSummary.stateStartedAtMs },
        currentSettings
      ),
      nowMs: Date.now()
    })
    const serialized = JSON.stringify(patch)
    if (serialized !== lastStatusBar) {
      lastStatusBar = serialized
      // Why: forget a rejected patch so the next identical one retries.
      void orca.host.call('statusBar.update', patch).catch(() => {
        if (lastStatusBar === serialized) {
          lastStatusBar = null
        }
      })
    }
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
    // Why: the token goes first. A keyring failure then leaves everything as
    // it was; writing the other fields first would apply them behind an
    // `ok:false` result, and an Application ID change would rebuild the
    // controller for nothing.
    if (nextSettings.bridgeToken !== previous.bridgeToken) {
      try {
        const store = await saveBridgeToken(orca.host, String(nextSettings.bridgeToken))
        tokenStore = store
        tokenWarnings = store === 'settings' ? [SECRETS_UNAVAILABLE_WARNING] : []
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
    if (settings.showSessionStats !== 'off' || settings.showLeaderboards) {
      await syncSessionsIfNeeded(false)
    }
    const activeStats =
      settings.showSessionStats !== 'off'
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
      session?.touch()
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
        sessionStartMs: session?.startMs(),
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
    timeline?.record((agentTable?.slots() ?? []).map((slot) => timelineStateFor(slot.canonicalState)))
    persistState()
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
    await persist({ ...settings, enabled: !settings.enabled })
    await refresh()
    publishStatusBar()
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

  // Why: `presence.open-panel` is declarative (manifest `action`), so it needs no
  // worker handler and no `workspace:write`, which `commands.run` would require.

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
  panels?.handle('presence.snapshot', () => {
    // Why: opening the panel can start a new session; refresh so Discord and storage get it.
    if (touchSession()) {
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
    touchSession()
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
  // Why: flush the strip and session on a clean stop so the next start restores them.
  if (timelineHost?.has('storage.set')) {
    const sessionState = session?.toJSON()
    await Promise.all([
      timeline
        ? timelineHost.call('storage.set', { key: TIMELINE_STORAGE_KEY, value: timeline.toJSON() }).catch(() => {})
        : undefined,
      sessionState
        ? timelineHost.call('storage.set', { key: SESSION_STORAGE_KEY, value: sessionState }).catch(() => {})
        : undefined
    ])
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
