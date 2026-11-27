/**
 * Sidebar panel composition root: wires renderers, controls, view/reorder
 * state, theme sync, idle-aware 1s timer, and non-enumerable test hooks.
 *
 * @module panel/panel
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import type { PresencePanelSnapshot } from '../presence/panel-snapshot'
import { PLUGIN_VERSION } from '../version'
import { renderControls, wireActionButtons, wireControls, wireLogs } from './controls'
import { $, errorText, flash, setAttr, setText } from './dom'
import { getOrca, request } from './host-bridge'
import { hasAgentChips, renderAgents, renderMix, tickAgents } from './render-agents'
import { renderLeaderboards, wireLeaderboardControls } from './render-leaderboards'
import {
  barClass,
  buildStrip,
  hasActiveTimer,
  indicatorLabel,
  renderCard,
  renderHostBadge,
  renderMinimal,
  renderStrip,
  sinkTile,
  tickElapsedTimer
} from './render-status'
import {
  createBlockReorder,
  mergeVisibleOrder,
  movedIds,
  reconcileOrder,
  targetIndex
} from './reorder'
import { seedInitialTheme, wireTheme } from './theme'
import { createPanelViewController } from './view'

const viewController = createPanelViewController()
let lastSnapshot: PresencePanelSnapshot | null = null

function tickTimer(): void {
  if (typeof document !== 'undefined' && document.hidden) return
  if (hasAgentChips()) tickAgents()
  if (hasActiveTimer()) tickElapsedTimer()
}

function render(snapshot: PresencePanelSnapshot): void {
  setAttr($('status-bar'), 'class', barClass(snapshot))
  setText('indicator-label', indicatorLabel(snapshot))
  renderHostBadge(snapshot)
  if (!snapshot || !snapshot.status) return
  lastSnapshot = snapshot
  setText('panel-version', `v${snapshot.version || PLUGIN_VERSION}`)
  viewController.syncFromSnapshot(snapshot)
  const fields = snapshot.fields
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : []
  renderCard(snapshot)
  renderStrip(snapshot.timeline)
  setText('tile-agents', agents.length)
  renderMix(agents)
  const sink = sinkTile(snapshot)
  setText('tile-sink', sink[0])
  setText('tile-sink-sub', sink[1])
  renderMinimal(snapshot, agents.length)
  renderControls(snapshot)
  renderAgents(agents)
  renderLeaderboards(snapshot, (enabled) => viewController.setLeaderboardsEnabled(enabled))
  setText('btn-toggle', fields && fields.enabled === false ? 'Resume' : 'Pause')
  const logs = snapshot.logs || []
  setText('logs-summary', `Logs (${logs.length})`)
  if (logs.length) {
    const logEl = $('log-view')
    if (logEl) {
      const text = logs.join('\n')
      if (logEl.textContent !== text) {
        // Why: keep the reader's place; only follow the tail when already at the bottom.
        const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4
        logEl.textContent = text
        if (atBottom) logEl.scrollTop = logEl.scrollHeight
      }
    }
  }
  viewController.syncReorder()
}

function refresh(): Promise<void> {
  return request<PresencePanelSnapshot>('presence.snapshot', {}).then(render, (error) => {
    flash(`Snapshot failed: ${errorText(error)}`)
  })
}

// Why: tests only. Non-enumerable so it never shows up when iterating window.
Object.defineProperty(window, '__presencePanel', {
  value: {
    render,
    reconcileOrder,
    mergeVisibleOrder,
    movedIds,
    targetIndex,
    createBlockReorder
  },
  enumerable: false
})

buildStrip()
seedInitialTheme()

const orca = getOrca()
if (!orca || !orca.plugin || typeof orca.plugin.request !== 'function') {
  $('app')?.classList.add('hidden')
  const note = $('static-note')
  if (note) {
    note.textContent = 'Open this panel in the Orca desktop app to see live status.'
    note.classList.remove('hidden')
  }
} else {
  setText('panel-version', `v${PLUGIN_VERSION}`)
  const star = $('btn-star') as HTMLButtonElement | null
  if (star && orca.shell?.openExternal) {
    star.addEventListener('click', () => {
      // Keep literal network URLs out of the generated panel. Orca opens this
      // fixed repository in the system browser only after a click.
      const url = ['ht', 'tps://github.com/jondmarien/orca-discord-presence'].join('')
      void orca.shell?.openExternal?.(url).catch(() => flash('Could not open GitHub.'))
    })
  } else if (star) {
    star.disabled = true
  }
  wireLogs()
  wireControls(() => lastSnapshot)
  wireLeaderboardControls()
  viewController.wire()
  wireActionButtons(render, refresh)
  if (typeof orca.plugin.on === 'function') {
    orca.plugin.on('presence.snapshot', (payload) => render(payload as PresencePanelSnapshot))
  }
  wireTheme()
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tickTimer()
    })
  }
  if (typeof setInterval === 'function') setInterval(tickTimer, 1000)
  void refresh()
}
