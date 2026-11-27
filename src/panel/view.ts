/**
 * Panel view mode (`full` / `minimal`), hideable-section tray, and drag-reorder
 * persistence backed by the shared `createMirroredPref()` state machine.
 *
 * @module panel/view
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import type { PanelSectionId } from '../presence/panel-constants'
import type { PresencePanelSnapshot } from '../presence/panel-snapshot'
import { $, clearChildren, flash, hasClass, setAttr, setClass, setText } from './dom'
import { callHost, createMirroredPref, getOrca, storedValue } from './host-bridge'
import { createBlockReorder, reconcileOrder, type BlockReorder } from './reorder'
import {
  DEFAULT_BLOCK_ORDER,
  MINIMAL_SECTIONS,
  PANEL_SECTIONS,
  SECTION_BY_ID
} from './sections'

const VIEW_KEY = 'panelView'
const HIDDEN_KEY = 'panelHidden'
const HIDDEN_SETTING = 'hiddenPanels'
const ORDER_KEY = 'panelOrder'
const ORDER_SETTING = 'panelOrder'

export type PanelViewController = {
  getView: () => 'full' | 'minimal'
  setLeaderboardsEnabled: (enabled: boolean) => void
  syncFromSnapshot: (snapshot: PresencePanelSnapshot) => void
  syncReorder: () => void
  wire: () => void
}

function normalizeHidden(list: unknown): PanelSectionId[] | null {
  if (!Array.isArray(list)) return null
  return PANEL_SECTIONS.map((s) => s[0]).filter((id) => list.includes(id))
}

function isDefaultOrder(list: readonly PanelSectionId[]): boolean {
  return list.join(',') === DEFAULT_BLOCK_ORDER.join(',')
}

function orderSettingValue(list: readonly PanelSectionId[]): string {
  return isDefaultOrder(list) ? '' : list.join(',')
}

export function createPanelViewController(): PanelViewController {
  let view: 'full' | 'minimal' = 'full'
  let leaderboardsEnabled = false
  let hiddenIds: PanelSectionId[] = []
  let traySignature: string | null = null
  let blockOrder: PanelSectionId[] = DEFAULT_BLOCK_ORDER.slice()
  let blockReorder: BlockReorder | null = null

  function viewHidden(): PanelSectionId[] {
    return hiddenIds.filter((id) => {
      if (id === 'leaderboards' && !leaderboardsEnabled) return false
      if (view === 'minimal') return MINIMAL_SECTIONS.includes(id)
      return true
    })
  }

  function renderTray(): void {
    const shown = viewHidden()
    const count = shown.length
    setClass($('hidden-tray'), 'hidden', count === 0)
    setText('hidden-tray-label', `Hidden (${count})`)
    setText('show-all-count', count || '')
    const showAllBtn = $('btn-show-all') as HTMLButtonElement | null
    if (showAllBtn) showAllBtn.disabled = count === 0
    const signature = `${view}:${shown.join(',')}`
    if (signature === traySignature) return
    traySignature = signature
    const box = $('hidden-chips')
    clearChildren(box)
    if (!box) return
    PANEL_SECTIONS.forEach(([id, , label]) => {
      if (!shown.includes(id)) return
      const chip = document.createElement('button')
      chip.setAttribute('type', 'button')
      chip.className = 'btn sm'
      chip.setAttribute('aria-label', `Show ${label}`)
      chip.textContent = label
      chip.addEventListener('click', () => {
        hiddenPref.set(hiddenIds.filter((item) => item !== id))
      })
      box.appendChild(chip)
    })
  }

  function applyHidden(list: PanelSectionId[]): void {
    hiddenIds = list
    PANEL_SECTIONS.forEach(([id, elementId]) => {
      const off = hiddenIds.includes(id)
      setClass($(elementId), 'user-hidden', off)
      setAttr($(`eye-${id}`), 'aria-pressed', off ? 'true' : 'false')
    })
    if (blockReorder) blockReorder.sync()
    renderTray()
  }

  function applyDomOrder(orderList: readonly string[]): void {
    blockOrder = reconcileOrder(orderList, DEFAULT_BLOCK_ORDER)
    const sections = $('sections')
    if (sections) {
      const kids = sections.children || []
      // Why: skip DOM reparenting when blocks are already in order, and only
      // move out-of-place nodes so unchanged cards never flash or lose state.
      const target: HTMLElement[] = []
      for (let i = 0; i < blockOrder.length; i += 1) {
        const info = SECTION_BY_ID[blockOrder[i]]
        const el = info ? $(info[1]) : null
        if (el) target.push(el)
      }
      let same = kids.length === target.length
      if (same) {
        for (let j = 0; j < target.length; j += 1) {
          if (kids[j] !== target[j]) {
            same = false
            break
          }
        }
      }
      if (!same) {
        for (let k = 0; k < target.length; k += 1) {
          const current = sections.children[k]
          if (current !== target[k]) {
            if (typeof sections.insertBefore === 'function') {
              sections.insertBefore(target[k], current || null)
            } else {
              sections.appendChild(target[k])
            }
          }
        }
      }
    }
    setClass($('order-footer'), 'hidden', isDefaultOrder(blockOrder))
  }

  function visibleBlocks(): HTMLElement[] {
    const sections = $('sections')
    if (!sections) return []
    const out: HTMLElement[] = []
    for (let i = 0; i < blockOrder.length; i += 1) {
      const info = SECTION_BY_ID[blockOrder[i]]
      const el = info ? $(info[1]) : null
      if (!el) continue
      if (hasClass(el, 'hidden') || hasClass(el, 'user-hidden') || hasClass(el, 'feature-disabled')) {
        continue
      }
      if (view === 'minimal' && hasClass(el, 'full-only')) continue
      out.push(el)
    }
    return out
  }

  const hiddenPref = createMirroredPref<PanelSectionId[]>({
    storageKey: HIDDEN_KEY,
    settingKey: HIDDEN_SETTING,
    getCurrent: () => hiddenIds,
    normalizeStorage: normalizeHidden,
    normalizeSetting: normalizeHidden,
    toStorageValue: (list) => list.slice(),
    toSettingValue: (list) => list.join(','),
    onApply: (list) => applyHidden(normalizeHidden(list) ?? [])
  })

  const orderPref = createMirroredPref<PanelSectionId[]>({
    storageKey: ORDER_KEY,
    settingKey: ORDER_SETTING,
    getCurrent: () => blockOrder,
    normalizeStorage: (raw) => (Array.isArray(raw) ? reconcileOrder(raw, DEFAULT_BLOCK_ORDER) : null),
    normalizeSetting: (raw) => (Array.isArray(raw) ? reconcileOrder(raw, DEFAULT_BLOCK_ORDER) : null),
    toStorageValue: (list) => (orderSettingValue(list) ? list.slice() : []),
    toSettingValue: orderSettingValue,
    onApply: (list) => applyDomOrder(list),
    mirrorImmediately: true,
    snapshotWins: true,
    canApplyExternal: () => !(blockReorder && blockReorder.dragging())
  })

  function applyView(next: unknown): void {
    view = next === 'minimal' ? 'minimal' : 'full'
    if (blockReorder) blockReorder.cancel()
    setAttr($('app'), 'data-view', view)
    setClass($('min-hero'), 'hidden', view !== 'minimal')
    setClass($('view-full'), 'on', view === 'full')
    setClass($('view-minimal'), 'on', view === 'minimal')
    renderTray()
  }

  function loadView(): Promise<void> {
    const host = getOrca()?.host
    if (!host || typeof host.call !== 'function') return Promise.resolve()
    return Promise.resolve()
      .then(() => host.call!('storage.get', { key: VIEW_KEY }))
      .then(
        (result) => applyView(storedValue(result)),
        () => applyView('full')
      )
  }

  function chooseView(next: 'full' | 'minimal'): void {
    applyView(next)
    callHost('storage.set', { key: VIEW_KEY, value: view })
  }

  function announceOrder(message: string): void {
    setText('order-live', message)
  }

  return {
    getView: () => view,
    setLeaderboardsEnabled(enabled) {
      if (enabled !== leaderboardsEnabled) {
        leaderboardsEnabled = enabled
        renderTray()
      }
    },
    syncFromSnapshot(snapshot) {
      hiddenPref.syncFromSnapshot(snapshot.hidden)
      orderPref.syncFromSnapshot(snapshot.order)
    },
    syncReorder() {
      if (blockReorder) blockReorder.sync()
    },
    wire() {
      $('view-full')?.addEventListener('click', () => chooseView('full'))
      $('view-minimal')?.addEventListener('click', () => chooseView('minimal'))
      void loadView()

      PANEL_SECTIONS.forEach(([id]) => {
        $(`eye-${id}`)?.addEventListener('click', () => {
          hiddenPref.set(hiddenIds.concat(id))
        })
      })
      const showAll = () => {
        // Why: in minimal view only minimal sections are offered, so show-all
        // restores just those; full-only sections stay hidden for the return trip.
        const keep = viewHidden()
        hiddenPref.set(hiddenIds.filter((id) => !keep.includes(id)))
      }
      $('btn-show-all')?.addEventListener('click', showAll)
      $('tray-show-all')?.addEventListener('click', showAll)
      renderTray()
      void hiddenPref.load()

      const sections = $('sections')
      if (sections) {
        blockReorder = createBlockReorder({
          container: sections,
          doc: document,
          win: window,
          getOrder: () => blockOrder,
          getVisibleBlocks: visibleBlocks,
          getLabel: (id) => {
            const def = (SECTION_BY_ID as Record<string, readonly [string, string, string] | undefined>)[id]
            return def ? def[2] : id
          },
          applyDomOrder,
          onCommit: (nextOrder) => orderPref.set(reconcileOrder(nextOrder, DEFAULT_BLOCK_ORDER)),
          onAnnounce: announceOrder
        })
      }
      $('btn-reset-order')?.addEventListener('click', () => {
        orderPref.set(DEFAULT_BLOCK_ORDER.slice())
        flash('Layout order reset.')
        announceOrder('Layout order reset to default.')
      })
      void orderPref.load()
    }
  }
}
