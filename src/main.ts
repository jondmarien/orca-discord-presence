/**
 * Orca plugin worker composition root: wires host runtime modules, commands,
 * events, panel RPC, and the heartbeat into the Discord presence controller.
 *
 * Orca loads the bundled Node ESM at `dist/main.js` (`orca-plugin.json`
 * `main`). `activate` must resolve inside `PLUGIN_WORKER_READY_TIMEOUT_MS`
 * (10s) or the host SIGKILLs the worker, so Discord detection and the initial
 * presence transmit run fire-and-forget.
 *
 * @module main
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { createAgentTable } from './presence/agents'
import { resolveActiveSessionStats } from './presence/leaderboards'
import type { PresenceSettings } from './presence/settings'
import { formatStatusTransmitting, registerCommands, type PanelCommandId } from './worker/commands'
import { createDiscordBinding } from './worker/discord-binding'
import {
  createDisposer,
  createHostDiagnostics,
  toSettingsValue,
  type ActivateDeps,
  type OrcaHost
} from './worker/host'
import { createHostSync, createRefreshRunner, registerHostEvents, seedHostState, type LatestAgentSummary } from './worker/host-sync'
import { createPanelRpc, type PanelRpc } from './worker/panel-rpc'
import { createPersistence } from './worker/persistence'
import { createSettingsRuntime } from './worker/settings-runtime'

export { formatStatusTransmitting, toSettingsValue, type ActivateDeps, type OrcaHost, type PanelCommandId }

/** Interval for the `workspace.readContext` keepalive & branch-check heartbeat. */
const HEARTBEAT_MS = 90_000

let activeWorker: { stop(): Promise<void> } | null = null

/**
 * Plugin entry. Loads persisted settings, wires worker modules, registers
 * commands, panel RPC, and events, and starts the heartbeat.
 */
export default async function activate(orca: OrcaHost, deps: ActivateDeps = {}) {
  const disposer = createDisposer()
  const settingsRuntime = await createSettingsRuntime({ orca, disposer })
  const { diagnostics, logRing } = createHostDiagnostics(
    orca,
    settingsRuntime.current(),
    settingsRuntime.appIdInspection
  )

  let latestSummary: LatestAgentSummary = { agentState: undefined, agentCount: 0 }
  let pushAgentRefresh = () => {}
  let panelRpcRef: PanelRpc | null = null

  const agentTable = createAgentTable({
    now: () => Date.now(),
    setTimer: (fn, ms) => disposer.setTimeout(fn, ms),
    clearTimer: (timer) => disposer.clearTimeout(timer as ReturnType<typeof setTimeout>),
    onChange: () => {
      hostSync.pruneKindCache()
      pushAgentRefresh()
    }
  })
  const persistence = await createPersistence({ host: orca.host, disposer })
  const hostSync = createHostSync({ host: orca.host, agentTable, disposer, diagnostics })

  const publishStatusBar = () => {
    const controller = binding.controller()
    persistence.publishStatusBar({
      status: controller.status(),
      settings: controller.settings(),
      agentState: latestSummary.agentState,
      agentCount: latestSummary.agentCount,
      stateStartedAtMs: latestSummary.stateStartedAtMs
    })
  }

  const binding = createDiscordBinding({
    settingsRuntime,
    disposer,
    diagnostics,
    log: (message) => orca.log(message),
    detectClients: deps.detect,
    makeDiscordClient: deps.createClient,
    onHealthChange: () => {
      publishStatusBar()
      panelRpcRef?.publish('debounced')
    },
    onNeedsHistory: async () => {
      await hostSync.syncWorkspaces(false)
      await hostSync.syncSessionsIfNeeded(settingsRuntime.current(), true)
    },
    getSessionStats: () =>
      resolveActiveSessionStats(agentTable.slots(), hostSync.sessions(), hostSync.focusedWorkspaceId()),
    onRepublish: async (opts) => refresh(undefined, opts),
    onAfterApply: () => {
      publishStatusBar()
      panelRpcRef?.publish('immediate')
    }
  })

  const panelRpc = createPanelRpc({
    orca,
    disposer,
    binding,
    settingsRuntime,
    persistence,
    hostSync,
    agentTable,
    logRing,
    diagnostics
  })
  panelRpcRef = panelRpc

  const refresh = createRefreshRunner({
    orca,
    agentTable,
    hostSync,
    settingsRuntime,
    persistence,
    binding,
    disposer,
    panelRpc,
    diagnostics,
    onSummary: (summary) => {
      latestSummary = summary
    },
    publishStatusBar
  })
  pushAgentRefresh = () => void refresh()

  const persist = (nextSettings: PresenceSettings) =>
    settingsRuntime.persist(nextSettings, (next) => binding.applySettings(next))
  const paletteHandlers = registerCommands({
    orca,
    settingsRuntime,
    binding,
    panelRpc,
    diagnostics,
    persist,
    refresh,
    publishStatusBar
  })
  panelRpc.register({ paletteHandlers, refresh })

  registerHostEvents(orca, agentTable, hostSync, refresh)
  await seedHostState(hostSync, settingsRuntime.current())
  settingsRuntime.watch((next) => binding.applySettings(next))
  disposer.setInterval(() => {
    void binding.redetect().then(() => refresh(undefined, { force: true }))
  }, HEARTBEAT_MS)

  activeWorker = {
    async stop() {
      disposer.disposeAll()
      await persistence.flush()
      diagnostics.line('info', 'deactivate')
      agentTable.clear()
      hostSync.clear()
      panelRpc.clear()
      await binding.stop()
    }
  }

  // Why: fire-and-forget so activate returns well inside the 10s worker timeout.
  void binding
    .redetect(true)
    .then(() => refresh(undefined, { startup: true }))
    .then(() => panelRpc.publish('immediate'))
}

/**
 * Plugin shutdown. Disposes all timers/subscriptions, flushes state, clears
 * Discord activity, and closes the IPC socket. Idempotent.
 */
export async function deactivate() {
  const worker = activeWorker
  activeWorker = null
  await worker?.stop()
}
