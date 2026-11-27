import { expect, test } from 'bun:test'
import vm from 'node:vm'
import { buildPanelHtml } from '../scripts/build-panel'

type Listener = (event?: Record<string, unknown>) => void

class ReorderFakeElement {
  id = ''
  tagName = 'DIV'
  textContent = ''
  className = ''
  value = ''
  checked = false
  disabled = false
  scrollTop = 0
  clientHeight = 0
  scrollHeight = 0
  offsetTop = 0
  offsetHeight = 100
  parentNode: ReorderFakeElement | null = null
  captured: number | null = null
  focused = false
  style: Record<string, string> = {}
  children: ReorderFakeElement[] = []
  attrs = new Map<string, string>()
  listeners = new Map<string, Listener[]>()
  classList = {
    add: (name: string) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean))
      set.add(name)
      this.className = [...set].join(' ')
    },
    remove: (name: string) => {
      this.className = this.className.split(/\s+/).filter((n) => n && n !== name).join(' ')
    },
    toggle: (name: string, on?: boolean) => {
      const has = this.className.split(/\s+/).includes(name)
      if (on === undefined ? !has : on) this.classList.add(name)
      else this.classList.remove(name)
    }
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    const payload = { type, target: this, ...event }
    let cur: ReorderFakeElement | null = this
    while (cur) {
      for (const fn of cur.listeners.get(type) ?? []) fn(payload)
      cur = cur.parentNode
    }
    return payload
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value))
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null
  }
  removeAttribute(name: string) {
    this.attrs.delete(name)
  }
  hasAttribute(name: string) {
    return this.attrs.has(name)
  }
  appendChild(child: ReorderFakeElement) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((c) => c !== child)
    }
    child.parentNode = this
    this.children.push(child)
    return child
  }
  insertBefore(child: ReorderFakeElement, ref: ReorderFakeElement | null) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((c) => c !== child)
    }
    child.parentNode = this
    if (!ref) {
      this.children.push(child)
    } else {
      const idx = this.children.indexOf(ref)
      if (idx === -1) this.children.push(child)
      else this.children.splice(idx, 0, child)
    }
    return child
  }
  removeChild(child: ReorderFakeElement) {
    this.children = this.children.filter((c) => c !== child)
    if (child.parentNode === this) child.parentNode = null
    return child
  }
  get firstChild() {
    return this.children[0] ?? null
  }
  setPointerCapture(pid: number) {
    this.captured = pid
  }
  releasePointerCapture(pid: number) {
    if (this.captured === pid) this.captured = null
  }
  focus() {
    this.focused = true
  }
  querySelector(selector: string): ReorderFakeElement | null {
    const attrMatch = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)
    if (!attrMatch) return null
    const [, attr, val] = attrMatch
    for (const child of this.children) {
      const got = child.getAttribute(attr)
      if (got !== null && (val === undefined || got === val)) return child
      const nested = child.querySelector(selector)
      if (nested) return nested
    }
    return null
  }
  getBoundingClientRect() {
    return { top: this.offsetTop, bottom: this.offsetTop + this.offsetHeight, left: 0, right: 300, width: 300, height: this.offsetHeight }
  }
}

const DEFAULT_BLOCKS = [
  ['actions', 'actions-row', true],
  ['preview', 'preview-card', true],
  ['strip', 'strip-card', false],
  ['tiles', 'tile-agents-card', true],
  ['sink', 'tile-sink-card', true],
  ['client', 'client-card', true],
  ['detail', 'detail-card', false],
  ['agents', 'agents-card', true],
  ['toggles', 'toggles-card', true],
  ['leaderboards', 'leaderboards-card', true],
  ['logs', 'logs-box', true]
] as const

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function mountReorderPanel(
  hostCall?: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  options: { heights?: Record<string, number>; useRealTimers?: boolean } = {}
) {
  const html = buildPanelHtml()
  const byId = new Map<string, ReorderFakeElement>()
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
    const el = new ReorderFakeElement()
    el.id = match[1]
    byId.set(match[1], el)
  }
  // Attach blocks and handles inside #sections with real parentNode links.
  const sections = byId.get('sections')!
  const handles = new Map<string, ReorderFakeElement>()
  for (const [blockId, elId, fullOnly] of DEFAULT_BLOCKS) {
    const block = byId.get(elId)!
    block.setAttribute('data-block', blockId)
    if (fullOnly) block.classList.add('full-only')
    if (blockId === 'client') block.classList.add('hidden')
    if (blockId === 'leaderboards') block.classList.add('feature-disabled')
    const handle = new ReorderFakeElement()
    handle.setAttribute('data-drag-handle', blockId)
    block.appendChild(handle)
    handles.set(blockId, handle)
    sections.appendChild(block)
  }

  const heights = options.heights ?? {}
  const relayout = () => {
    let top = 0
    for (const child of sections.children) {
      const id = child.getAttribute('data-block') ?? ''
      const view = byId.get('app')?.getAttribute('data-view') ?? 'full'
      const hidden =
        child.className.split(/\s+/).some((c) => c === 'hidden' || c === 'user-hidden' || c === 'feature-disabled') ||
        (view === 'minimal' && child.className.split(/\s+/).includes('full-only'))
      if (hidden) continue
      const h = heights[id] ?? 100
      child.offsetTop = top
      child.offsetHeight = h
      top += h + 10
    }
    sections.offsetTop = 0
    sections.offsetHeight = Math.max(0, top - 10)
  }
  const origAppend = sections.appendChild.bind(sections)
  sections.appendChild = (child: ReorderFakeElement) => {
    const res = origAppend(child)
    relayout()
    return res
  }
  const origInsert = sections.insertBefore.bind(sections)
  sections.insertBefore = (child: ReorderFakeElement, ref: ReorderFakeElement | null) => {
    const res = origInsert(child, ref)
    relayout()
    return res
  }
  relayout()

  const docListeners = new Map<string, Listener[]>()
  const winListeners = new Map<string, Listener[]>()
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  let scrollY = 0

  const document = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => new ReorderFakeElement(),
    createTextNode: (text: string) => Object.assign(new ReorderFakeElement(), { textContent: text }),
    querySelectorAll: () => [],
    querySelector: (sel: string) => sections.querySelector(sel),
    documentElement: new ReorderFakeElement(),
    addEventListener: (type: string, fn: Listener) => {
      docListeners.set(type, [...(docListeners.get(type) ?? []), fn])
    }
  }
  const orca = {
    plugin: { request: () => new Promise(() => {}), on() {} },
    host: { has: () => false, ...(hostCall ? { call: hostCall } : {}) },
    on() {}
  }
  const timerApi = options.useRealTimers
    ? { setTimeout, clearTimeout }
    : {
        setTimeout: (fn: () => void, ms: number) => {
          const t = { fn, ms, cancelled: false }
          timers.push(t)
          return t
        },
        clearTimeout: (t: { cancelled: boolean } | null) => {
          if (t) t.cancelled = true
        }
      }
  const sandbox = vm.createContext({
    document,
    navigator: {},
    orca,
    setInterval: () => 0,
    innerHeight: 600,
    scrollTo: (_x: number, y: number) => {
      scrollY = y
    },
    scrollBy: (_x: number, dy: number) => {
      scrollY = Math.max(0, scrollY + dy)
    },
    addEventListener: (type: string, fn: Listener) => {
      winListeners.set(type, [...(winListeners.get(type) ?? []), fn])
    },
    ...timerApi
  })
  Object.defineProperty(sandbox, 'scrollY', {
    get: () => scrollY,
    set: (v: number) => {
      scrollY = v
    }
  })
  vm.runInContext('globalThis.window = globalThis', sandbox)
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''
  vm.runInContext(script, sandbox)

  const hook = (sandbox as { __presencePanel: Record<string, (...args: unknown[]) => unknown> }).__presencePanel
  const visibleOrder = () => {
    relayout()
    const view = byId.get('app')?.getAttribute('data-view') ?? 'full'
    return sections.children
      .filter(
        (c) =>
          !c.className.split(/\s+/).some((cls) => cls === 'hidden' || cls === 'user-hidden' || cls === 'feature-disabled') &&
          !(view === 'minimal' && c.className.split(/\s+/).includes('full-only'))
      )
      .map((c) => c.getAttribute('data-block'))
  }
  const fullOrder = () => sections.children.map((c) => c.getAttribute('data-block'))

  return {
    byId,
    sections,
    handles,
    hook,
    relayout,
    visibleOrder,
    fullOrder,
    fireDoc: (type: string, event: Record<string, unknown>) => {
      for (const fn of docListeners.get(type) ?? []) fn(event)
    },
    fireWin: (type: string, event: Record<string, unknown> = {}) => {
      for (const fn of winListeners.get(type) ?? []) fn(event)
    },
    runTimers: () => {
      for (const t of timers.splice(0)) {
        if (!t.cancelled) t.fn()
      }
    }
  }
}

test('pure helpers: reconcileOrder, mergeVisibleOrder, movedIds, targetIndex midpoint hysteresis', () => {
  const { hook } = mountReorderPanel()
  const reconcileOrder = hook.reconcileOrder as (s: unknown, d: string[]) => string[]
  const mergeVisibleOrder = hook.mergeVisibleOrder as (v: string[], f: string[]) => string[]
  const movedIds = hook.movedIds as (ids: string[], id: string, to: number) => string[]
  const targetIndex = hook.targetIndex as (
    items: Array<{ offsetTop: number; offsetHeight: number }>,
    active: { offsetTop: number; offsetHeight: number },
    y: number
  ) => number

  expect(reconcileOrder(['c', 'nope', 'a', 'c'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd'])
  expect(reconcileOrder(null, ['a', 'b'])).toEqual(['a', 'b'])
  // Minimal reorder swaps only visible slots while preserving hidden full-only slots.
  expect(mergeVisibleOrder(['detail', 'strip'], ['actions', 'preview', 'strip', 'tiles', 'detail', 'logs'])).toEqual([
    'actions',
    'preview',
    'detail',
    'tiles',
    'strip',
    'logs'
  ])
  expect(movedIds(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
  expect(movedIds(['a', 'b', 'c'], 'c', -5)).toEqual(['c', 'a', 'b'])

  // Unequal heights: short block (38px actions) above tall block (210px toggles).
  const short = { offsetTop: 0, offsetHeight: 38 }
  const tall = { offsetTop: 48, offsetHeight: 210 }
  expect(targetIndex([short, tall], short, 140)).toBe(0) // above midpoint (153) -> stays
  expect(targetIndex([short, tall], short, 160)).toBe(1) // past midpoint -> swaps
  // After swap, tall is on top (0..210, mid=105), short is below (220..258). Pointer at 160 stays!
  const tallTop = { offsetTop: 0, offsetHeight: 210 }
  const shortBot = { offsetTop: 220, offsetHeight: 38 }
  expect(targetIndex([tallTop, shortBot], shortBot, 160)).toBe(1)
  expect(targetIndex([tallTop, shortBot], shortBot, 100)).toBe(0)
})

test('mouse drag via handle lifts past 5px, reorders, preserves log scroll, commits & resets', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const p = mountReorderPanel(
    async (name, input) => {
      calls.push([name, input])
      return undefined
    },
    { heights: { actions: 40, preview: 100, strip: 100, tiles: 80, sink: 80, detail: 80, agents: 120, toggles: 210, logs: 140 } }
  )
  await settle()
  p.byId.get('log-view')!.scrollTop = 75
  const handle = p.handles.get('actions')!
  const actionsEl = p.byId.get('actions-row')!

  // Below 5px threshold -> not dragging.
  handle.dispatch('pointerdown', { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 20, clientY: 20 })
  p.sections.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 21, clientY: 22 })
  expect(actionsEl.hasAttribute('data-dragging')).toBe(false)

  // Past threshold -> lifts, captures pointer on stationary container, crosses preview midpoint (50 + 50 = 100).
  p.sections.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 20, clientY: 110 })
  expect(actionsEl.hasAttribute('data-dragging')).toBe(true)
  expect(p.sections.captured).toBe(1)
  expect(p.visibleOrder().slice(0, 3)).toEqual(['preview', 'actions', 'strip'])
  expect(p.byId.get('log-view')!.scrollTop).toBe(75)

  // Live snapshot mid-drag preserves lifted block transform.
  p.hook.render({
    version: '1.2.0',
    generatedAt: '2026-11-26T00:00:00.000Z',
    status: { enabled: true, connected: true, sink: 'local', detailLevel: 'generic', bridgeEnabled: false, debugLogging: false, lastActivity: null, logFile: null, client: null, clients: [], clientFallback: false },
    fields: { enabled: true },
    timeline: [],
    agents: [],
    activityCard: null,
    logs: [],
    logHint: '~/log',
    hidden: [],
    order: [],
    leaderboards: { enabled: false, rows: [] }
  })
  expect(actionsEl.hasAttribute('data-dragging')).toBe(true)
  expect(actionsEl.style.transform).toContain('translateY(')

  // Drop commits to storage.set and settings.set, shows Reset layout footer.
  p.sections.dispatch('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: 20, clientY: 110 })
  p.runTimers()
  await settle()
  expect(actionsEl.hasAttribute('data-dragging')).toBe(false)
  expect(p.sections.captured).toBeNull()
  expect(p.byId.get('order-footer')?.className.includes('hidden')).toBe(false)
  expect(p.byId.get('order-live')?.textContent).toContain('Actions, position 2')
  expect(calls.some(([n, i]) => n === 'storage.set' && i.key === 'panelOrder' && (i.value as string[])[0] === 'preview')).toBe(true)
  expect(calls.some(([n, i]) => n === 'settings.set' && i.key === 'panelOrder' && String(i.value).startsWith('preview,actions'))).toBe(true)

  // Reset layout button restores default order and hides itself.
  p.byId.get('btn-reset-order')?.dispatch('click')
  p.runTimers()
  await settle()
  expect(p.visibleOrder()[0]).toBe('actions')
  expect(p.byId.get('order-footer')?.className.includes('hidden')).toBe(true)
  expect(calls.at(-1)).toEqual(['settings.set', { key: 'panelOrder', value: '' }])
})

test('Escape, pointercancel, blur roll back drag; buttons===0 finishes missed release; touch requires hold', async () => {
  const calls: Array<[string, Record<string, unknown>]> = []
  const p = mountReorderPanel(async (n, i) => {
    calls.push([n, i])
    return undefined
  })
  await settle()
  const handle = p.handles.get('actions')!

  // Escape rollback
  handle.dispatch('pointerdown', { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 50 })
  p.sections.dispatch('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 10, clientY: 170 })
  expect(p.visibleOrder()[0]).toBe('preview')
  p.fireDoc('keydown', { key: 'Escape', preventDefault() {} })
  expect(p.visibleOrder()[0]).toBe('actions')
  expect(calls.filter(([n]) => n === 'storage.set')).toHaveLength(0)

  // pointercancel rollback
  handle.dispatch('pointerdown', { button: 0, pointerId: 2, pointerType: 'mouse', clientX: 10, clientY: 50 })
  p.sections.dispatch('pointermove', { pointerId: 2, pointerType: 'mouse', buttons: 1, clientX: 10, clientY: 170 })
  p.sections.dispatch('pointercancel', { pointerId: 2 })
  expect(p.visibleOrder()[0]).toBe('actions')

  // window blur rollback
  handle.dispatch('pointerdown', { button: 0, pointerId: 3, pointerType: 'mouse', clientX: 10, clientY: 50 })
  p.sections.dispatch('pointermove', { pointerId: 3, pointerType: 'mouse', buttons: 1, clientX: 10, clientY: 170 })
  p.fireWin('blur')
  expect(p.visibleOrder()[0]).toBe('actions')

  // Missed mouseup outside panel (buttons === 0 on pointermove) finishes cleanly
  handle.dispatch('pointerdown', { button: 0, pointerId: 4, pointerType: 'mouse', clientX: 10, clientY: 50 })
  p.sections.dispatch('pointermove', { pointerId: 4, pointerType: 'mouse', buttons: 1, clientX: 10, clientY: 170 })
  p.sections.dispatch('pointermove', { pointerId: 4, pointerType: 'mouse', buttons: 0, clientX: 10, clientY: 170 })
  expect(p.byId.get('actions-row')?.hasAttribute('data-dragging')).toBe(false)
  expect(p.visibleOrder()[0]).toBe('preview')

  // Touch swipe (>10px slop before hold timer) cancels press; touch hold lifts
  const previewHandle = p.handles.get('preview')!
  previewHandle.dispatch('pointerdown', { button: 0, pointerId: 5, pointerType: 'touch', clientX: 10, clientY: 50 })
  p.sections.dispatch('pointermove', { pointerId: 5, pointerType: 'touch', clientX: 10, clientY: 75 })
  p.runTimers()
  expect(p.byId.get('preview-card')?.hasAttribute('data-dragging')).toBe(false)

  previewHandle.dispatch('pointerdown', { button: 0, pointerId: 6, pointerType: 'touch', clientX: 10, clientY: 50 })
  p.runTimers()
  expect(p.byId.get('preview-card')?.hasAttribute('data-dragging')).toBe(true)
  p.sections.dispatch('pointercancel', { pointerId: 6 })
})

test('keyboard Alt+ArrowUp/Down reorders, announces, keeps hidden slots and Minimal order', async () => {
  const p = mountReorderPanel()
  await settle()
  // Alt+ArrowDown on actions handle moves it below preview.
  const actionsHandle = p.handles.get('actions')!
  actionsHandle.dispatch('keydown', { key: 'ArrowDown', altKey: true, preventDefault() {} })
  expect(p.visibleOrder().slice(0, 2)).toEqual(['preview', 'actions'])
  expect(actionsHandle.focused).toBe(true)
  expect(p.byId.get('order-live')?.textContent).toContain('Actions, position 2')

  // Hide actions, then restore it -> returns to position 2 (its custom slot!).
  p.byId.get('eye-actions')?.dispatch('click')
  expect(p.visibleOrder().includes('actions')).toBe(false)
  p.byId.get('tray-show-all')?.dispatch('click')
  expect(p.visibleOrder().slice(0, 2)).toEqual(['preview', 'actions'])

  // Switch to Minimal view (only strip and detail visible), move detail above strip.
  p.byId.get('view-minimal')?.dispatch('click')
  expect(p.visibleOrder()).toEqual(['strip', 'detail'])
  p.handles.get('detail')!.dispatch('keydown', { key: 'ArrowUp', altKey: true, preventDefault() {} })
  expect(p.visibleOrder()).toEqual(['detail', 'strip'])
  // Switch back to Full -> preview still above actions, detail now before strip, full-only slots preserved!
  p.byId.get('view-full')?.dispatch('click')
  const order = p.visibleOrder()
  expect(order.indexOf('preview')).toBe(0)
  expect(order.indexOf('actions')).toBe(1)
  expect(order.indexOf('detail')).toBeLessThan(order.indexOf('strip'))
})
