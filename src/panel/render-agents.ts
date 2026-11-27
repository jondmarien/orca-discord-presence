/**
 * Agents list, click-to-focus (`presence.focus-agent`), state mix bar,
 * marquee title overflow measurement, and per-second chip age updates.
 *
 * @module panel/render-agents
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import type { PresencePanelAgent } from '../presence/panel-snapshot'
import {
  $,
  clearChildren,
  displayState,
  errorText,
  flash,
  formatSince,
  normalizeState,
  setAttr,
  setClass
} from './dom'
import { request } from './host-bridge'
import { STATES } from './sections'

const MARQUEE_PX_PER_S = 30

let marqueeTitles: HTMLElement[] = []
let agentChips: Array<{ agent: PresencePanelAgent; chip: HTMLElement }> = []
let agentsSignature: string | null = null
let mixSignature: string | null = null

function scheduleMarquee(): void {
  // Why: measure after layout; environments without a frame callback (tests) skip marquee.
  if (typeof window.requestAnimationFrame !== 'function') return
  window.requestAnimationFrame(() => {
    marqueeTitles.forEach((title) => {
      const overflow = title.scrollWidth - title.clientWidth
      if (overflow > 2) {
        title.classList.add('marquee')
        title.style.setProperty('--marquee-shift', `${-overflow}px`)
        // Pause ~1.5s at each end; the slide itself runs at a steady speed.
        title.style.setProperty('--marquee-duration', `${(overflow / MARQUEE_PX_PER_S) * 2 + 3}s`)
      } else {
        title.classList.remove('marquee')
      }
    })
  })
}

function chipText(agent: PresencePanelAgent): string {
  let label = displayState(agent.state)
  if (agent.outcome === 'failure') label += ' (failed)'
  else if (agent.outcome === 'interruption') label += ' (interrupted)'
  return `${label} \u00b7 ${formatSince(Math.max(0, Date.now() - agent.sinceMs))}`
}

export function hasAgentChips(): boolean {
  return agentChips.length > 0
}

export function tickAgents(): void {
  agentChips.forEach((entry) => {
    const next = chipText(entry.agent)
    if (entry.chip.textContent !== next) entry.chip.textContent = next
    // Why: a narrow chip ellipsizes, so the full age stays on hover.
    setAttr(entry.chip, 'title', next)
  })
}

export function renderAgents(agents: readonly PresencePanelAgent[]): void {
  const list = Array.isArray(agents) ? agents : []
  const signature = list
    .map(
      (a) =>
        `${a.kind}|${a.title || ''}|${a.taskTitle || ''}|${a.state}|${a.outcome || ''}|${a.focusKey || ''}|${a.sinceMs}`
    )
    .join(';')
  setClass($('agents-empty'), 'hidden', list.length > 0)
  if (signature === agentsSignature) return
  agentsSignature = signature
  const box = $('agents-list')
  if (!box) return
  clearChildren(box)
  agentChips = []
  marqueeTitles = []
  list.forEach((agent) => {
    const clickable = typeof agent.focusKey === 'string' && agent.focusKey.length > 0
    const row = document.createElement(clickable ? 'button' : 'div')
    row.className = clickable ? 'agent-row agent-btn' : 'agent-row'
    if (clickable) {
      row.setAttribute('type', 'button')
      row.setAttribute('title', 'Jump to agent terminal')
      row.addEventListener('click', () => {
        request<{ ok?: boolean; message?: string }>('presence.focus-agent', { key: agent.focusKey }).then(
          (res) => {
            if (res && res.ok === false) flash(res.message || 'Could not focus agent terminal.')
          },
          (error) => {
            flash(`Focus failed: ${errorText(error)}`)
          }
        )
      })
    }
    // Why: kind, muted ` | `, then the chat or task name; only the title truncates.
    const label = document.createElement('span')
    label.className = 'agent-label'
    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = String(agent.kind || 'agent')
    label.appendChild(kind)
    const displayTitle = agent.title || agent.taskTitle || ''
    if (displayTitle) {
      const sep = document.createElement('span')
      sep.className = 'sep'
      sep.textContent = ' | '
      const title = document.createElement('span')
      title.className = 'title'
      const hoverTitle =
        agent.title && agent.taskTitle && agent.taskTitle !== agent.title
          ? `${agent.title} \u2014 ${agent.taskTitle}`
          : displayTitle
      title.setAttribute('title', String(hoverTitle))
      const inner = document.createElement('span')
      inner.className = 'title-inner'
      inner.textContent = String(displayTitle)
      title.appendChild(inner)
      label.appendChild(sep)
      label.appendChild(title)
      marqueeTitles.push(title)
    }
    const chip = document.createElement('span')
    chip.className = 'chip'
    const state = normalizeState(displayState(agent.state))
    chip.setAttribute('data-state', state)
    chip.textContent = chipText(agent)
    chip.setAttribute('title', chip.textContent)
    agentChips.push({ agent, chip })
    row.appendChild(label)
    row.appendChild(chip)
    box.appendChild(row)
  })
  scheduleMarquee()
}

export function renderMix(agents: readonly PresencePanelAgent[]): void {
  const counts: Record<string, number> = {}
  ;(Array.isArray(agents) ? agents : []).forEach((agent) => {
    const state = normalizeState(displayState(agent.state))
    counts[state] = (counts[state] || 0) + 1
  })
  const signature = STATES.map((s) => `${s}${counts[s]}`).join(',')
  if (signature === mixSignature) return
  mixSignature = signature
  const mix = $('tile-mix')
  if (!mix) return
  clearChildren(mix)
  STATES.forEach((state) => {
    if (!counts[state]) return
    const part = document.createElement('i')
    part.setAttribute('data-state', state)
    part.style.flex = String(counts[state])
    mix.appendChild(part)
  })
}
