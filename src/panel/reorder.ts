/**
 * Pure Pointer Events vertical block reordering for the Orca isolated panel.
 *
 * Mechanics adapted from mswdev/orca-fleet-monitor (PRs #7 & #8): root pointer
 * capture, dragstart suppression, midpoint hysteresis for unequal heights,
 * scroll-jump protection, time-based edge auto-scroll, FLIP sibling slides,
 * Escape/cancel rollback, and Alt+Arrow keyboard fallback.
 *
 * @module panel/reorder
 * @author Jonathan Marien
 * @date 2026-11-26
 */

const REORDER_DRAG_PX = 5
const REORDER_TOUCH_HOLD_MS = 350
const REORDER_TOUCH_SLOP_PX = 10
const REORDER_DROP_MS = 180
const REORDER_EDGE_PX = 48
const REORDER_SCROLL_PX_PER_MS = 14 / 16.7
const REORDER_REVEAL_PX = 8
const REORDER_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

export function reconcileOrder<T extends string>(saved: unknown, defaults: readonly T[]): T[] {
  const known = new Set<string>(defaults)
  const seen = new Set<string>()
  const out: T[] = []
  if (Array.isArray(saved)) {
    for (const raw of saved) {
      const id = typeof raw === 'string' ? raw.trim() : ''
      if (id && known.has(id) && !seen.has(id)) {
        seen.add(id)
        out.push(id as T)
      }
    }
  }
  for (const id of defaults) {
    if (!seen.has(id)) {
      out.push(id)
    }
  }
  return out
}

export function mergeVisibleOrder<T extends string>(
  visibleIds: readonly T[],
  fullOrder: readonly T[]
): T[] {
  const visibleSet = new Set<string>(visibleIds)
  const next = fullOrder.slice()
  let cursor = 0
  for (let j = 0; j < next.length; j += 1) {
    if (visibleSet.has(next[j]) && cursor < visibleIds.length) {
      next[j] = visibleIds[cursor]
      cursor += 1
    }
  }
  while (cursor < visibleIds.length) {
    if (!next.includes(visibleIds[cursor])) {
      next.push(visibleIds[cursor])
    }
    cursor += 1
  }
  return next
}

export function movedIds<T extends string>(ids: readonly T[], id: T, toIndex: number): T[] {
  const from = ids.indexOf(id)
  if (from === -1) return ids.slice()
  const to = Math.max(0, Math.min(ids.length - 1, toIndex))
  if (to === from) return ids.slice()
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

export type LayoutItem = {
  offsetTop: number
  offsetHeight: number
}

/**
 * Midpoint hysteresis using layout offsetTop/offsetHeight (ignores CSS transform).
 * Only swaps past the neighbor's vertical midpoint in the direction of travel,
 * so short blocks (actions) and tall blocks (toggles/logs) never oscillate.
 */
export function targetIndex<T extends LayoutItem>(items: readonly T[], activeItem: T, pointerY: number): number {
  const from = items.indexOf(activeItem)
  if (from === -1) return -1
  for (let i = 0; i < items.length; i += 1) {
    if (i === from) continue
    const item = items[i]
    const top = item.offsetTop
    const height = item.offsetHeight
    if (pointerY < top || pointerY > top + height) continue
    const mid = top + height / 2
    if (i > from && pointerY >= mid) return i
    if (i < from && pointerY <= mid) return i
    return from
  }
  return from
}

export type BlockReorderOptions = {
  container: HTMLElement
  doc?: Document
  win?: Window
  getVisibleBlocks: () => HTMLElement[]
  getLabel: (id: string) => string
  applyDomOrder: (nextOrder: string[]) => void
  onCommit: (nextOrder: string[]) => void
  onAnnounce?: (message: string) => void
  getOrder: () => readonly string[]
  motion?: () => boolean
  later?: (fn: () => void, ms: number) => unknown
  cancelLater?: (id: unknown) => void
  frame?: (fn: (ts: number) => void) => unknown
  cancelFrame?: (id: unknown) => void
}

export type BlockReorder = {
  dragging: () => boolean
  cancel: () => boolean
  sync: () => void
  consumeClick: (event?: { detail?: number } | null) => boolean
  moveByKeyboard: (id: string, delta: number) => boolean
}

type PressState = {
  id: string
  pointerId: number
  pointerType: string
  startClientX: number
  startClientY: number
  clientY: number
  timer: unknown
}

type DragState = {
  id: string
  pointerId: number
  pointerType: string
  clientY: number
  grabOffsetY: number
  startFullOrder: string[]
  currentFullOrder: string[]
  startVisibleIds: string[]
  currentVisibleIds: string[]
  scrollRaf: unknown
  scrollLastTs: number
}

export function createBlockReorder(options: BlockReorderOptions): BlockReorder {
  const container = options.container
  const doc = options.doc || document
  const win = options.win || window
  const getVisibleBlocks = options.getVisibleBlocks
  const getLabel = options.getLabel
  const applyDomOrder = options.applyDomOrder
  const onCommit = options.onCommit
  const onAnnounce = options.onAnnounce
  const getOrder = options.getOrder
  const motionOn =
    options.motion ||
    (() => !(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches))
  const later = options.later || ((fn, ms) => setTimeout(fn, ms))
  const cancelLater =
    options.cancelLater || ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
  const reqFrame =
    options.frame ||
    ((fn) =>
      typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame(fn)
        : later(() => fn(Date.now()), 16))
  const cancelFrame =
    options.cancelFrame ||
    ((id) => {
      if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(id as number)
      else cancelLater(id)
    })

  let press: PressState | null = null
  let drag: DragState | null = null
  let suppressClickUntil = 0

  function closestMatching(node: EventTarget | null, attr: string): HTMLElement | null {
    let cur = node as HTMLElement | null
    while (cur && cur !== container) {
      if (typeof cur.getAttribute === 'function' && cur.getAttribute(attr) != null) return cur
      cur = cur.parentNode as HTMLElement | null
    }
    return null
  }

  function containerOriginY(): number {
    if (typeof container.getBoundingClientRect === 'function') {
      return container.getBoundingClientRect().top
    }
    return 0
  }

  function blockById(id: string): HTMLElement | null {
    const blocks = getVisibleBlocks()
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].getAttribute('data-block') === id) return blocks[i]
    }
    return null
  }

  function clampDeltaY(el: HTMLElement, rawDy: number): number {
    const minDy = -el.offsetTop
    const containerH = container.offsetHeight || 0
    const maxDy = containerH > 0 ? Math.max(0, containerH - (el.offsetTop + el.offsetHeight)) : rawDy
    if (rawDy < minDy) return minDy
    if (rawDy > maxDy) return maxDy
    return rawDy
  }

  function applyLiftTransform(): void {
    if (!drag) return
    const el = blockById(drag.id)
    if (!el) return
    const pointerInContainer = drag.clientY - containerOriginY()
    const desiredTop = pointerInContainer - drag.grabOffsetY
    const dy = clampDeltaY(el, desiredTop - el.offsetTop)
    el.setAttribute('data-dragging', '')
    el.style.transform = `translateY(${Math.round(dy)}px)`
  }

  function animateFlip(beforeTops: Record<string, number>, skipId: string | null): void {
    if (!motionOn()) return
    const blocks = getVisibleBlocks()
    for (let i = 0; i < blocks.length; i += 1) {
      const el = blocks[i]
      const id = el.getAttribute('data-block')
      if (!id || id === skipId) continue
      if (beforeTops[id] === undefined) continue
      const dy = beforeTops[id] - el.offsetTop
      if (Math.abs(dy) < 1) continue
      if (typeof el.animate === 'function') {
        try {
          el.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0px)' }],
            { duration: REORDER_DROP_MS, easing: REORDER_EASE }
          )
        } catch {}
      }
    }
  }

  function snapshotTops(): Record<string, number> {
    const tops: Record<string, number> = {}
    const blocks = getVisibleBlocks()
    for (let i = 0; i < blocks.length; i += 1) {
      const id = blocks[i].getAttribute('data-block')
      if (id) tops[id] = blocks[i].offsetTop
    }
    return tops
  }

  function reorderInPlace(nextOrder: string[], skipFlipId: string | null): void {
    const beforeTops = snapshotTops()
    const savedScrollY = typeof win.scrollY === 'number' ? win.scrollY : 0
    const logEl = doc.getElementById ? doc.getElementById('log-view') : null
    const savedLogScroll = logEl && typeof logEl.scrollTop === 'number' ? logEl.scrollTop : null
    applyDomOrder(nextOrder)
    if (savedLogScroll !== null && logEl && logEl.scrollTop !== savedLogScroll) {
      logEl.scrollTop = savedLogScroll
    }
    if (typeof win.scrollTo === 'function' && typeof win.scrollY === 'number' && win.scrollY !== savedScrollY) {
      win.scrollTo(0, savedScrollY)
    }
    animateFlip(beforeTops, skipFlipId)
  }

  function stopAutoScroll(): void {
    if (drag && drag.scrollRaf != null) {
      cancelFrame(drag.scrollRaf)
      drag.scrollRaf = null
      drag.scrollLastTs = 0
    }
  }

  function stepAutoScroll(ts: number): void {
    if (!drag) return
    drag.scrollRaf = null
    const vh = win.innerHeight || 0
    if (vh <= 0 || typeof win.scrollBy !== 'function') return
    let dir = 0
    let ratio = 0
    if (drag.clientY < REORDER_EDGE_PX) {
      dir = -1
      ratio = Math.min(1, (REORDER_EDGE_PX - drag.clientY) / REORDER_EDGE_PX)
    } else if (drag.clientY > vh - REORDER_EDGE_PX) {
      dir = 1
      ratio = Math.min(1, (drag.clientY - (vh - REORDER_EDGE_PX)) / REORDER_EDGE_PX)
    }
    if (!dir) {
      drag.scrollLastTs = 0
      return
    }
    const dt = drag.scrollLastTs ? Math.min(48, Math.max(0, ts - drag.scrollLastTs)) : 16
    drag.scrollLastTs = ts
    win.scrollBy(0, dir * REORDER_SCROLL_PX_PER_MS * dt * (0.4 + 0.6 * ratio))
    updateDragPosition()
    drag.scrollRaf = reqFrame(stepAutoScroll)
  }

  function ensureAutoScroll(): void {
    if (!drag || drag.scrollRaf != null) return
    const vh = win.innerHeight || 0
    if (vh <= 0) return
    if (drag.clientY < REORDER_EDGE_PX || drag.clientY > vh - REORDER_EDGE_PX) {
      drag.scrollLastTs = 0
      drag.scrollRaf = reqFrame(stepAutoScroll)
    }
  }

  function clearPress(): void {
    if (!press) return
    if (press.timer != null) {
      cancelLater(press.timer)
    }
    press = null
  }

  function beginDrag(p: PressState): void {
    const visible = getVisibleBlocks()
    if (visible.length < 2) {
      clearPress()
      return
    }
    const el = blockById(p.id)
    if (!el) {
      clearPress()
      return
    }
    const visibleIds = visible.map((b) => b.getAttribute('data-block') || '')
    const fullOrder = getOrder().slice()
    drag = {
      id: p.id,
      pointerId: p.pointerId,
      pointerType: p.pointerType,
      clientY: p.clientY,
      grabOffsetY: p.startClientY - containerOriginY() - el.offsetTop,
      startFullOrder: fullOrder,
      currentFullOrder: fullOrder,
      startVisibleIds: visibleIds,
      currentVisibleIds: visibleIds,
      scrollRaf: null,
      scrollLastTs: 0
    }
    clearPress()
    container.setAttribute('data-reordering', '')
    if (typeof container.setPointerCapture === 'function') {
      try {
        container.setPointerCapture(drag.pointerId)
      } catch {}
    }
    applyLiftTransform()
    ensureAutoScroll()
  }

  function updateDragPosition(): void {
    if (!drag) return
    const visible = getVisibleBlocks()
    const el = blockById(drag.id)
    if (!el || visible.length < 2) {
      finish(false)
      return
    }
    const pointerInContainer = drag.clientY - containerOriginY()
    const nextIdx = targetIndex(visible, el, pointerInContainer)
    const currentIdx = visible.indexOf(el)
    if (nextIdx >= 0 && nextIdx !== currentIdx) {
      const nextVisible = movedIds(drag.currentVisibleIds, drag.id, nextIdx)
      const nextFull = mergeVisibleOrder(nextVisible, drag.currentFullOrder)
      drag.currentVisibleIds = nextVisible
      drag.currentFullOrder = nextFull
      reorderInPlace(nextFull, drag.id)
    }
    applyLiftTransform()
  }

  function finish(commit: boolean): boolean {
    if (!drag) return false
    const active = drag
    stopAutoScroll()
    drag = null
    suppressClickUntil = Date.now() + 250
    container.removeAttribute('data-reordering')
    if (typeof container.releasePointerCapture === 'function') {
      try {
        container.releasePointerCapture(active.pointerId)
      } catch {}
    }
    let el = blockById(active.id)
    const prevTransform = el ? el.style.transform : ''
    if (!commit) {
      reorderInPlace(active.startFullOrder, active.id)
    }
    el = blockById(active.id)
    if (el) {
      el.removeAttribute('data-dragging')
      el.style.transform = ''
      if (motionOn() && prevTransform && typeof el.animate === 'function') {
        try {
          el.animate([{ transform: prevTransform }, { transform: 'translateY(0px)' }], {
            duration: REORDER_DROP_MS,
            easing: REORDER_EASE
          })
        } catch {}
      }
    }
    const changed = active.currentFullOrder.join(',') !== active.startFullOrder.join(',')
    if (commit && changed) {
      onCommit(active.currentFullOrder)
      const idx = active.currentVisibleIds.indexOf(active.id)
      if (idx !== -1 && onAnnounce) {
        onAnnounce(`${getLabel(active.id)}, position ${idx + 1} of ${active.currentVisibleIds.length}`)
      }
    }
    return true
  }

  function revealBlock(el: HTMLElement | null): void {
    if (!el || typeof el.getBoundingClientRect !== 'function' || typeof win.scrollBy !== 'function') return
    const rect = el.getBoundingClientRect()
    const vh = win.innerHeight || 0
    if (vh <= 0) return
    if (rect.top < REORDER_REVEAL_PX) {
      win.scrollBy(0, rect.top - REORDER_REVEAL_PX)
    } else if (rect.bottom > vh - REORDER_REVEAL_PX) {
      win.scrollBy(0, rect.bottom - (vh - REORDER_REVEAL_PX))
    }
  }

  function moveByKeyboard(id: string, delta: number): boolean {
    if (drag) return false
    const visible = getVisibleBlocks()
    const visibleIds = visible.map((b) => b.getAttribute('data-block') || '')
    const at = visibleIds.indexOf(id)
    const to = Math.max(0, Math.min(visibleIds.length - 1, at + delta))
    if (at === -1 || to === at) return false
    const nextVisible = movedIds(visibleIds, id, to)
    const nextFull = mergeVisibleOrder(nextVisible, getOrder())
    reorderInPlace(nextFull, null)
    onCommit(nextFull)
    const movedEl = blockById(id)
    const handle =
      movedEl && typeof movedEl.querySelector === 'function'
        ? (movedEl.querySelector('[data-drag-handle]') as HTMLElement | null)
        : doc.querySelector
          ? (doc.querySelector(`[data-drag-handle="${id}"]`) as HTMLElement | null)
          : null
    if (handle && typeof handle.focus === 'function') {
      try {
        handle.focus({ preventScroll: true })
      } catch {
        handle.focus()
      }
    }
    revealBlock(movedEl)
    if (onAnnounce) {
      onAnnounce(`${getLabel(id)}, position ${to + 1} of ${nextVisible.length}`)
    }
    return true
  }

  container.addEventListener('dragstart', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
  })

  container.addEventListener('contextmenu', (event) => {
    if ((press && press.pointerType === 'touch') || drag) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
    }
  })

  container.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!event) return
    if (event.isPrimary === false) return
    if (typeof event.button === 'number' && event.button !== 0) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const handle = closestMatching(event.target, 'data-drag-handle')
    if (!handle) return
    const id = handle.getAttribute('data-drag-handle')
    if (!id) return
    if (getVisibleBlocks().length < 2) return
    clearPress()
    press = {
      id,
      pointerId: event.pointerId == null ? 1 : event.pointerId,
      pointerType: event.pointerType || 'mouse',
      startClientX: event.clientX || 0,
      startClientY: event.clientY || 0,
      clientY: event.clientY || 0,
      timer: null
    }
    if (press.pointerType === 'touch') {
      const captured = press
      press.timer = later(() => {
        if (press === captured) beginDrag(captured)
      }, REORDER_TOUCH_HOLD_MS)
    }
  })

  container.addEventListener('pointermove', (event: PointerEvent) => {
    if (!event) return
    const pid = event.pointerId == null ? 1 : event.pointerId
    if (event.pointerType === 'mouse' && typeof event.buttons === 'number' && event.buttons === 0) {
      clearPress()
      if (drag) finish(true)
      return
    }
    if (drag && drag.pointerId === pid) {
      drag.clientY = event.clientY || 0
      updateDragPosition()
      ensureAutoScroll()
      return
    }
    if (press && press.pointerId === pid) {
      const dx = (event.clientX || 0) - press.startClientX
      const dy = (event.clientY || 0) - press.startClientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      press.clientY = event.clientY || 0
      if (press.pointerType === 'touch') {
        if (dist > REORDER_TOUCH_SLOP_PX) clearPress()
      } else if (dist >= REORDER_DRAG_PX) {
        beginDrag(press)
        if (drag) {
          drag.clientY = event.clientY || 0
          updateDragPosition()
        }
      }
    }
  })

  container.addEventListener('pointerup', (event: PointerEvent) => {
    const pid = event && event.pointerId != null ? event.pointerId : 1
    if (press && press.pointerId === pid) clearPress()
    if (drag && drag.pointerId === pid) finish(true)
  })

  container.addEventListener('pointercancel', (event: PointerEvent) => {
    const pid = event && event.pointerId != null ? event.pointerId : 1
    if (press && press.pointerId === pid) clearPress()
    if (drag && drag.pointerId === pid) finish(false)
  })

  container.addEventListener(
    'touchmove',
    (event) => {
      if (drag && event && typeof event.preventDefault === 'function') {
        event.preventDefault()
      }
    },
    { passive: false }
  )

  container.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!event || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (!delta) return
    const handle = closestMatching(event.target, 'data-drag-handle')
    if (!handle) return
    const id = handle.getAttribute('data-drag-handle')
    if (!id) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    moveByKeyboard(id, delta)
  })

  if (typeof doc.addEventListener === 'function') {
    doc.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event && event.key === 'Escape' && drag) {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        finish(false)
      }
    })
  }

  if (typeof win.addEventListener === 'function') {
    win.addEventListener('blur', () => {
      clearPress()
      if (drag) finish(false)
    })
    win.addEventListener('scroll', () => {
      if (drag) updateDragPosition()
    })
  }

  return {
    dragging: () => !!drag,
    cancel() {
      clearPress()
      return finish(false)
    },
    sync() {
      if (!drag) return
      if (!blockById(drag.id)) {
        finish(false)
        return
      }
      applyLiftTransform()
    },
    consumeClick(event) {
      if (event && event.detail === 0) return false
      return Date.now() < suppressClickUntil
    },
    moveByKeyboard
  }
}
