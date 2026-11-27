/**
 * Panel RPC handlers (`presence.snapshot`, `presence.refresh`,
 * `presence.focus-agent`, `presence.run`) and coalesced `panels.post` pushing.
 *
 * Registers every `panels.handle()` disposable with the worker disposer so
 * `deactivate()` leaves zero leaked handlers or timers.
 *
 * @module worker/panel-rpc
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import type { AgentSlot, AgentTable } from '../presence/agents'
import { buildWorkspaceLeaderboard } from '../presence/leaderboards'
import type { DiagnosticSink } from '../presence/log'
import type { LogRing } from '../presence/log-ring'
import { buildPresencePanelSnapshot, type PresencePanelSnapshot } from '../presence/panel-snapshot'
import { PLUGIN_VERSION } from '../version'
import { PANEL_COMMANDS, type RefreshFn } from './commands'
import type { DiscordBinding } from './discord-binding'
import { invalidParams, type Disposer, type OrcaHost } from './host'
import type { HostSync } from './host-sync'
import type { WorkerPersistence } from './persistence'
import type { SettingsRuntime } from './settings-runtime'

/** Coalesce `panels.post` pushes during a chatty agent event stream. */
export const PANEL_POST_DEBOUNCE_MS = 2_000

/** Minimum interval between full panel Refresh resyncs. */
export const PANEL_REFRESH_MIN_MS = 2_000

export type PanelRpc = {
  currentSnapshot: () => PresencePanelSnapshot | null
  publish: (mode: 'immediate' | 'debounced') => void
  register: (deps: {
    paletteHandlers: ReadonlyMap<string, () => Promise<unknown>>
    refresh: RefreshFn
  }) => void
  clear: () => void
}

export function createPanelRpc({
  orca,
  disposer,
  binding,
  settingsRuntime,
  persistence,
  hostSync,
  agentTable,
  logRing,
  diagnostics,
  now = () => Date.now(),
  postDebounceMs = PANEL_POST_DEBOUNCE_MS,
  refreshMinMs = PANEL_REFRESH_MIN_MS
}: {
  orca: OrcaHost
  disposer: Disposer
  binding: DiscordBinding
  settingsRuntime: SettingsRuntime
  persistence: WorkerPersistence
  hostSync: HostSync
  agentTable: AgentTable
  logRing: LogRing
  diagnostics?: DiagnosticSink
  now?: () => number
  postDebounceMs?: number
  refreshMinMs?: number
}): PanelRpc {
  const panels = orca.panels ?? null
  let postTimer: ReturnType<typeof setTimeout> | null = null
  let focusHandles = new Map<string, string>()
  let terminalToFocusKey = new Map<string, string>()
  let nextFocusHandleId = 1
  let lastPanelRefreshAt = 0

  function currentSnapshot(): PresencePanelSnapshot | null {
    if (disposer.isDisposed()) {
      return null
    }
    const controller = binding.controller()
    const currentSettings = controller.settings()
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
      ? buildWorkspaceLeaderboard(hostSync.sessions(), hostSync.workspaces())
      : []
    const snapshot = buildPresencePanelSnapshot({
      version: PLUGIN_VERSION,
      status: controller.status(),
      settings: currentSettings,
      logs: logRing.lines(),
      timeline: persistence.timelineSlots(),
      agents: agentTable.slots(),
      hostKind: hostSync.focusedHostKind(),
      focusKeyOf,
      leaderboardRows
    })
    return snapshot
  }

  function flushPost() {
    postTimer = null
    const snapshot = currentSnapshot()
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

  function publish(mode: 'immediate' | 'debounced') {
    if (disposer.isDisposed()) {
      return
    }
    if (mode === 'immediate') {
      disposer.clearTimeout(postTimer)
      postTimer = null
      flushPost()
      return
    }
    if (postTimer) {
      return
    }
    postTimer = disposer.setTimeout(flushPost, postDebounceMs)
  }

  return {
    currentSnapshot,
    publish,
    register({ paletteHandlers, refresh }) {
      if (!panels) {
        return
      }
      // Why: the panel talks to the worker through `plugin.request`. Guarded:
      // older hosts and browser clients have no `orca.panels`.
      disposer.add(
        panels.handle('presence.snapshot', () => {
          // Why: opening the panel can start a new session; refresh so Discord and storage get it.
          if (persistence.touchSession()) {
            void refresh()
          }
          return currentSnapshot()
        })
      )

      disposer.add(
        panels.handle('presence.refresh', async () => {
          const clock = now()
          if (lastPanelRefreshAt > 0 && clock - lastPanelRefreshAt < refreshMinMs) {
            return currentSnapshot()
          }
          lastPanelRefreshAt = clock
          persistence.touchSession()
          await hostSync.syncAgentsFromList({ allWorkspaces: true })
          await hostSync.syncSessionsIfNeeded(settingsRuntime.current(), true)
          // Why: a stalled Discord holds SET_ACTIVITY (and a rebind's clear) for 5s,
          // as long as the panel's request timeout. The panel sees the result on the
          // next `panels.post`. `refresh` re-reads `workspace.readContext` and force-transmits.
          void binding
            .redetect(true)
            .then(() => refresh(undefined, { force: true }))
            .catch((error) =>
              diagnostics?.line('error', 'panel.refresh_failed', {
                reason: error instanceof Error ? error.message : String(error)
              })
            )
          return currentSnapshot()
        })
      )

      disposer.add(
        panels.handle('presence.focus-agent', async (input) => {
          const key = (input as { key?: unknown } | null | undefined)?.key
          if (typeof key !== 'string' || key.length === 0) {
            throw invalidParams('presence.focus-agent requires a non-empty key')
          }
          const terminalId = focusHandles.get(key)
          if (!terminalId || !orca.host.has('terminal.focus')) {
            return { ok: false, focused: false }
          }
          try {
            const result = (await orca.host.call('terminal.focus', { terminalId })) as {
              focused?: unknown
            } | null
            return { ok: true, focused: Boolean(result?.focused) }
          } catch (error) {
            return {
              ok: false,
              focused: false,
              message: error instanceof Error ? error.message : String(error)
            }
          }
        })
      )

      disposer.add(
        panels.handle('presence.run', async (input) => {
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
      )
    },
    clear() {
      disposer.clearTimeout(postTimer)
      postTimer = null
      focusHandles.clear()
      terminalToFocusKey.clear()
      nextFocusHandleId = 1
    }
  }
}
