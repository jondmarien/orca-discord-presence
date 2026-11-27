/**
 * Local workspace Leaderboards card renderer and client-side metric sorting.
 *
 * @module panel/render-leaderboards
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { formatCompactCount, type WorkspaceLeaderboardRow } from '../presence/leaderboards'
import type { PresencePanelSnapshot } from '../presence/panel-snapshot'
import { $, clearChildren, setAttr, setClass } from './dom'

type LeaderboardMetric = 'tokens' | 'messages'

let lbMetric: LeaderboardMetric = 'tokens'
let lbRowsCache: WorkspaceLeaderboardRow[] = []
let lbSignature: string | null = null

export function drawLeaderboardRows(): void {
  const card = $('leaderboards-card')
  setAttr(card, 'data-lb-metric', lbMetric)
  setClass($('lb-sort-messages'), 'on', lbMetric === 'messages')
  setAttr($('lb-sort-messages'), 'aria-pressed', lbMetric === 'messages' ? 'true' : 'false')
  setClass($('lb-sort-tokens'), 'on', lbMetric === 'tokens')
  setAttr($('lb-sort-tokens'), 'aria-pressed', lbMetric === 'tokens' ? 'true' : 'false')

  const sorted = lbRowsCache
    .slice()
    .sort((a, b) => {
      if (lbMetric === 'messages') {
        return b.messages - a.messages || b.tokens - a.tokens || String(a.name).localeCompare(String(b.name))
      }
      return b.tokens - a.tokens || b.messages - a.messages || String(a.name).localeCompare(String(b.name))
    })
    .slice(0, 5)

  const hasRows = sorted.length > 0
  setClass($('lb-head'), 'hidden', !hasRows)
  setClass($('lb-empty'), 'hidden', hasRows)

  const sig = `${lbMetric}|${sorted.map((r) => `${r.name}:${r.messages}:${r.tokens}`).join(';')}`
  if (sig === lbSignature) return
  lbSignature = sig

  const box = $('lb-rows')
  if (!box) return
  clearChildren(box)

  let maxVal = 0
  sorted.forEach((r) => {
    const val = lbMetric === 'messages' ? r.messages : r.tokens
    if (val > maxVal) maxVal = val
  })

  sorted.forEach((r) => {
    const row = document.createElement('div')
    row.className = 'lb-row'
    const top = document.createElement('div')
    top.className = 'lb-row-top'
    const name = document.createElement('span')
    name.className = 'lb-name'
    name.textContent = String(r.name)
    name.setAttribute('title', String(r.name))
    const msgs = document.createElement('span')
    msgs.className = `lb-num lb-msg${lbMetric === 'messages' ? ' active' : ''}`
    msgs.textContent = formatCompactCount(r.messages)
    const toks = document.createElement('span')
    toks.className = `lb-num lb-tok${lbMetric === 'tokens' ? ' active' : ''}`
    toks.textContent = formatCompactCount(r.tokens)
    top.appendChild(name)
    top.appendChild(msgs)
    top.appendChild(toks)
    const bar = document.createElement('div')
    bar.className = 'lb-bar'
    const fill = document.createElement('i')
    const val = lbMetric === 'messages' ? r.messages : r.tokens
    const pct = maxVal > 0 ? Math.max(4, Math.round((val / maxVal) * 100)) : 0
    fill.style.width = `${pct}%`
    bar.appendChild(fill)
    row.appendChild(top)
    row.appendChild(bar)
    box.appendChild(row)
  })
}

export function renderLeaderboards(
  snapshot: PresencePanelSnapshot,
  onEnabledChange: (enabled: boolean) => void
): void {
  const fields = snapshot.fields
  const lb = snapshot.leaderboards
  const enabled = !!(fields?.showLeaderboards || lb?.enabled)
  const card = $('leaderboards-card')
  setClass(card, 'feature-disabled', !enabled)
  setAttr(card, 'data-lb-metric', lbMetric)
  onEnabledChange(enabled)
  if (!enabled) return
  lbRowsCache = lb && Array.isArray(lb.rows) ? lb.rows : []
  drawLeaderboardRows()
}

export function wireLeaderboardControls(): void {
  $('lb-sort-messages')?.addEventListener('click', () => {
    lbMetric = 'messages'
    drawLeaderboardRows()
  })
  $('lb-sort-tokens')?.addEventListener('click', () => {
    lbMetric = 'tokens'
    drawLeaderboardRows()
  })
}
