/**
 * Status header, Discord preview card, minimal hero, 30-minute timeline strip,
 * summary tiles, and elapsed timer rendering.
 *
 * @module panel/render-status
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import type { PresencePanelSnapshot } from '../presence/panel-snapshot'
import { $, clearChildren, formatElapsed, setAttr, setClass, setText, stateImage } from './dom'
import { HOST_LABELS, STATE_ASSET_RE, STATES, TIMELINE_CELLS, type PanelState } from './sections'

let timerStartMs: number | null = null
let minAgents = 0

export function barClass(snapshot: PresencePanelSnapshot | null | undefined): string {
  let kind = 'is-waiting'
  if (snapshot && snapshot.status) {
    if (!snapshot.fields || snapshot.fields.enabled === false) kind = 'is-disabled'
    else if (snapshot.status.connected) kind = snapshot.status.localFailing ? 'is-failing' : 'is-connected'
    else if (snapshot.status.sink === 'bridge') kind = 'is-bridge'
    else if (snapshot.status.enabled) kind = 'is-down'
    else kind = 'is-disabled'
  }
  return `row between ${kind}`
}

export function indicatorLabel(snapshot: PresencePanelSnapshot | null | undefined): string {
  if (!snapshot || !snapshot.status) return 'Waiting for worker snapshot'
  if (snapshot.fields && snapshot.fields.enabled === false) return 'Disabled'
  if (snapshot.status.connected) {
    return snapshot.status.localFailing ? 'Connected · updates failing' : 'Connected · local'
  }
  if (snapshot.status.sink === 'bridge') return 'Publishing · bridge'
  if (snapshot.status.enabled) return 'Disconnected'
  return 'Disabled'
}

export function sinkTile(snapshot: PresencePanelSnapshot): readonly [string, string] {
  const status = snapshot.status
  if (snapshot.fields && snapshot.fields.enabled === false) return ['Off', 'Disabled']
  if (status.connected) {
    return ['Local', status.client && status.client.label ? `${status.client.label} \u00b7 IPC` : 'Discord IPC']
  }
  if (status.sink === 'bridge') return ['Bridge', 'Companion app']
  return ['Off', 'Not connected']
}

export function renderHostBadge(snapshot: PresencePanelSnapshot | null | undefined): void {
  const kind = snapshot && snapshot.status && snapshot.status.hostKind
  const label = kind ? HOST_LABELS[kind] ?? '' : ''
  setClass($('host-badge'), 'hidden', !label)
  if (label) setText('host-badge', label)
}

export function buildStrip(): void {
  const strip = $('strip')
  if (!strip) return
  for (let i = 0; i < TIMELINE_CELLS; i += 1) {
    const cell = document.createElement('i')
    cell.setAttribute('data-state', 'none')
    strip.appendChild(cell)
  }
}

function slotStates(slot: unknown): PanelState[] {
  if (Array.isArray(slot)) {
    return slot.filter((s): s is PanelState => typeof s === 'string' && (STATES as readonly string[]).includes(s))
  }
  return typeof slot === 'string' && (STATES as readonly string[]).includes(slot) ? [slot as PanelState] : []
}

export function renderStrip(timeline: unknown): void {
  const strip = $('strip')
  if (!strip) return
  const cells = strip.children
  const slots = Array.isArray(timeline) ? timeline : []
  // Why: a short timeline aligns to the right edge ("now"); the rest is no data.
  const offset = TIMELINE_CELLS - Math.min(slots.length, TIMELINE_CELLS)
  const start = Math.max(0, slots.length - TIMELINE_CELLS)
  for (let i = 0; i < cells.length; i += 1) {
    const states = i < offset ? [] : slotStates(slots[start + i - offset])
    const cell = cells[i]
    setAttr(cell, 'data-state', states.length ? states[0] : 'none')
    setClass(cell, 'multi', states.length > 1)
    const joined = states.join(' ')
    if ((cell.getAttribute('data-states') || '') === joined) continue
    setAttr(cell, 'data-states', joined)
    clearChildren(cell)
    if (states.length > 1) {
      states.forEach((state) => {
        const seg = document.createElement('b')
        seg.setAttribute('data-state', state)
        cell.appendChild(seg)
      })
    }
  }
}

export function stateOf(snapshot: PresencePanelSnapshot): string {
  const card = snapshot.activityCard
  const match = card && STATE_ASSET_RE.exec(card.smallImageKey)
  return match ? match[1] : 'idle'
}

export function updateMeta(): void {
  const parts = [`${minAgents}${minAgents === 1 ? ' agent' : ' agents'}`]
  if (timerStartMs != null) parts.push(formatElapsed(Date.now() - timerStartMs))
  setText('min-meta', parts.join(' \u00b7 '))
}

export function hasActiveTimer(): boolean {
  return timerStartMs != null
}

export function tickElapsedTimer(): void {
  if (timerStartMs == null) return
  setText('dcard-timer', `${formatElapsed(Date.now() - timerStartMs)} elapsed`)
  updateMeta()
}

export function renderCard(snapshot: PresencePanelSnapshot): void {
  const card = snapshot.activityCard
  const summary = snapshot.status.lastActivity
  const details = card ? card.details : summary && summary.details
  const state = card ? card.state : summary && summary.state
  setText('dcard-details', details, 'Waiting for first update')
  setText('dcard-state', state)
  // Why: the key becomes part of a file path, so only known state assets pass.
  const match = card && STATE_ASSET_RE.exec(card.smallImageKey)
  setAttr($('dcard-img'), 'src', stateImage(match ? match[1] : 'idle'))
  const showTimer = !!(card && card.startMs) && !(snapshot.fields && snapshot.fields.showElapsed === false)
  timerStartMs = showTimer && card ? card.startMs : null
  setClass($('dcard-timer'), 'hidden', !showTimer)
  if (timerStartMs != null) {
    setText('dcard-timer', `${formatElapsed(Date.now() - timerStartMs)} elapsed`)
  }
}

export function renderMinimal(snapshot: PresencePanelSnapshot, agentCount: number): void {
  minAgents = agentCount
  const state = stateOf(snapshot)
  const card = snapshot.activityCard
  const summary = snapshot.status.lastActivity
  const details = card ? card.details : summary && summary.details
  setAttr($('min-hero'), 'data-state', state)
  setAttr($('min-img'), 'src', stateImage(state))
  setText('min-state', state.charAt(0).toUpperCase() + state.slice(1))
  setText('min-details', details ? `\u201c${details}\u201d` : '')
  updateMeta()
}
