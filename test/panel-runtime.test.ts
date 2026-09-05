import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const panelHtmlPath = join(dirname(fileURLToPath(import.meta.url)), '../panel/index.html')

type FakeEl = {
  id: string
  tagName: string
  textContent: string
  checked: boolean
  disabled: boolean
  value: string
  open: boolean
  className: string
  dataset: Record<string, string>
  attributes: Record<string, string>
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  listeners: Array<{ type: string; fn: (event?: unknown) => void }>
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  addEventListener: (type: string, fn: (event?: unknown) => void) => void
  classList: { toggle: (name: string, on?: boolean) => void }
}

function makeEl(tag: string, attrs: string, body = ''): FakeEl {
  const attributes: Record<string, string> = {}
  const attrRe = /([:@A-Za-z0-9-]+)(?:="([^"]*)")?/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(attrs))) {
    attributes[match[1]] = match[2] ?? ''
  }
  const dataset: Record<string, string> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('data-')) {
      const camel = key
        .slice(5)
        .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
      dataset[camel] = value
    }
  }
  const el: FakeEl = {
    id: attributes.id ?? '',
    tagName: tag.toUpperCase(),
    textContent: body,
    checked: Object.prototype.hasOwnProperty.call(attributes, 'checked'),
    disabled: Object.prototype.hasOwnProperty.call(attributes, 'disabled'),
    value: attributes.value ?? '',
    open: Object.prototype.hasOwnProperty.call(attributes, 'open'),
    className: attributes.class ?? '',
    dataset,
    attributes,
    scrollTop: 0,
    scrollHeight: 40,
    clientHeight: 40,
    listeners: [],
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value
      if (name === 'class') this.className = value
    },
    addEventListener(type: string, fn: (event?: unknown) => void) {
      this.listeners.push({ type, fn })
    },
    classList: {
      toggle: (name: string, on?: boolean) => {
        const parts = el.className.split(/\s+/).filter(Boolean)
        const has = parts.includes(name)
        const enable = on === undefined ? !has : on
        el.className = enable
          ? has
            ? parts.join(' ')
            : [...parts, name].join(' ')
          : parts.filter((part) => part !== name).join(' ')
      }
    }
  }
  return el
}

function parsePanelDocument(html: string) {
  const byId = new Map<string, FakeEl>()
  const extras: FakeEl[] = []
  const tagRe = /<([a-zA-Z0-9]+)([^>]*)>/g
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = tagRe.exec(html))) {
    const tag = tagMatch[1]
    const attrs = tagMatch[2]
    const id = /id="([^"]+)"/.exec(attrs)?.[1]
    let body = ''
    if (tag === 'script' && id) {
      const close = html.indexOf('</script>', tagMatch.index)
      body = close === -1 ? '' : html.slice(tagMatch.index + tagMatch[0].length, close)
    }
    const el = makeEl(tag, attrs, body)
    if (id) {
      byId.set(id, el)
    } else if (/\bdata-(?:setting|tab)=/.test(attrs) || /\bclass="[^"]*\bpanel\b/.test(attrs)) {
      extras.push(el)
    }
  }
  const all = [...byId.values(), ...extras]
  return { byId, all }
}

function loadPanelRuntime() {
  const html = readFileSync(panelHtmlPath, 'utf8')
  const parsed = parsePanelDocument(html)
  const scriptMatch = html.match(/<script>\s*'use strict'([\s\S]*)<\/script>\s*<\/body>/)
  if (!scriptMatch) {
    throw new Error('panel runtime script not found')
  }
  let active: FakeEl | { tagName: string } = { tagName: 'BODY' }
  const scrollingElement = { scrollTop: 0 }
  const document = {
    getElementById: (id: string) => parsed.byId.get(id) ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === '.toggles [data-setting]') {
        return parsed.all.filter((el) => el.getAttribute('data-setting'))
      }
      if (selector === '.tabs [data-tab]') {
        return parsed.all.filter((el) => el.getAttribute('data-tab'))
      }
      if (selector === '.panel') {
        return parsed.all.filter((el) => el.tagName === 'SECTION' && /\bpanel\b/.test(el.className))
      }
      return []
    },
    get activeElement() {
      return active
    },
    setActive(el: FakeEl | { tagName: string }) {
      active = el
    },
    scrollingElement,
    documentElement: scrollingElement,
    body: scrollingElement
  }
  const window = {
    parent: null as unknown,
    __PRESENCE_PANEL__: null as unknown,
    addEventListener: () => {},
    navigator: {},
    document
  }
  window.parent = window
  const api = new Function(
    'window',
    'document',
    `'use strict';
    ${scriptMatch[1]}
    return {
      renderSnapshot: renderSnapshot,
      applyStorageSnapshot: applyStorageSnapshot,
      applySettingsRecord: applySettingsRecord
    };`
  )(window, document) as {
    renderSnapshot: (snapshot: unknown, mode?: string) => void
    applyStorageSnapshot: (envelope: unknown) => void
    applySettingsRecord: (record: unknown) => void
  }
  return { api, byId: parsed.byId, document }
}

function liveSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: '0.6.1',
    generatedAt: '2026-09-05T09:13:04.848Z',
    status: {
      enabled: true,
      connected: true,
      sink: 'local',
      detailLevel: 'workspace',
      bridgeEnabled: false,
      debugLogging: true,
      lastActivity: { details: 'testing', state: 'Idle' },
      logFile: '/tmp/plugin.log',
      sidecarMailbox: false,
      heldClear: false
    },
    fields: {
      enabled: true,
      showBranch: true,
      showAgentState: true,
      showTerminals: true,
      showMachine: true,
      showElapsed: true,
      bridgeEnabled: true,
      debugLogging: true,
      showOpenButton: true,
      showAgentCount: true,
      showFocusedSurface: true,
      focusedSurfaceDetail: 'kind+title',
      showAgentType: true,
      showAgentModel: true,
      showAgentProfile: true
    },
    host: { sidecar: false, focus: false, executionHost: true },
    logs: ['[chron0.discord-presence] info activate'],
    logHint: '/tmp/plugin.log',
    ...overrides
  }
}

test('storage poll updates status and logs without resetting Settings chrome', () => {
  const { api, byId } = loadPanelRuntime()
  const enabled = byId.get('f-enabled')!
  const branch = byId.get('f-branch')!
  const detail = byId.get('f-focus-detail')!
  const logsBox = byId.get('logs-box')!
  const logView = byId.get('log-view')!
  const settingsTab = byId.get('tab-settings')!
  const aboutTab = byId.get('tab-about')!

  enabled.checked = false
  branch.checked = false
  detail.value = 'kind'
  logsBox.open = false
  logView.scrollTop = 12
  settingsTab.className = 'panel active'
  aboutTab.className = 'panel'

  api.applyStorageSnapshot({
    value: liveSnapshot({
      generatedAt: '2026-09-05T09:13:06.001Z',
      logs: ['[chron0.discord-presence] info activate', 'panel.snapshot_written']
    })
  })

  expect(enabled.checked).toBe(false)
  expect(branch.checked).toBe(false)
  expect(detail.value).toBe('kind')
  expect(logsBox.open).toBe(false)
  expect(settingsTab.className.includes('active')).toBe(true)
  expect(aboutTab.className.includes('active')).toBe(false)
  expect(byId.get('st-enabled')!.textContent).toBe('true')
  expect(byId.get('st-activity')!.textContent).toBe('testing · Idle')
  expect(logView.textContent.includes('panel.snapshot_written')).toBe(true)
})

test('live snapshot updates restore the Settings page scroll position', () => {
  const { api, document } = loadPanelRuntime()
  document.scrollingElement.scrollTop = 140
  api.applyStorageSnapshot({
    value: liveSnapshot({
      generatedAt: '2026-09-05T09:14:00.000Z',
      logs: ['[chron0.discord-presence] info activate', 'later line']
    })
  })
  expect(document.scrollingElement.scrollTop).toBe(140)
})

test('generatedAt-only snapshot rewrites do not re-render the Settings surface', () => {
  const { api, byId } = loadPanelRuntime()
  const first = liveSnapshot({ generatedAt: '2026-09-05T09:13:04.848Z', logs: ['same'] })
  api.applyStorageSnapshot({ value: first })
  const generated = byId.get('st-generated')!.textContent
  byId.get('f-enabled')!.checked = false
  byId.get('logs-box')!.open = false

  api.applyStorageSnapshot({
    value: liveSnapshot({ generatedAt: '2026-09-05T09:13:14.848Z', logs: ['same'] })
  })

  expect(byId.get('st-generated')!.textContent).toBe(generated)
  expect(byId.get('f-enabled')!.checked).toBe(false)
  expect(byId.get('logs-box')!.open).toBe(false)
})
