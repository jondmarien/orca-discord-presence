import { expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHIPPED_APPLICATION_ID, DEFAULT_SETTINGS } from '../src/presence/settings'
import { createLogRing } from '../src/presence/log-ring'
import {
  embedPanelSnapshot,
  extractPanelSnapshot,
  extractPanelVersion,
  resolvePanelHtmlPath,
  serializePanelSnapshot,
  stampPanelVersion,
  writePanelSnapshot
} from '../src/presence/panel-html'
import {
  buildPresencePanelSnapshot,
  CONVENTIONAL_LOG_HINT,
  formatPanelStatusToast,
  redactPanelLogLine,
  snapshotLeaksSecrets,
  summarizePanelActivity
} from '../src/presence/panel-snapshot'
import { PLUGIN_VERSION } from '../src/version'
import type { PresenceStatus } from '../src/presence/controller'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const panelHtmlPath = join(root, 'panel/index.html')

function statusWith(overrides: Partial<PresenceStatus> = {}): PresenceStatus {
  return {
    enabled: true,
    connected: true,
    bridgeEnabled: false,
    sink: 'local',
    detailLevel: 'generic',
    lastActivity: { details: 'Working in Orca', assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-idle', small_text: 'idle' } },
    logFile: '/tmp/plugin.log',
    sidecarMailbox: false,
    heldClear: false,
    ...overrides
  }
}

test('log ring drops the oldest lines once it is full', () => {
  const ring = createLogRing(3)
  ring.push('a')
  ring.push('b')
  ring.push('c')
  ring.push('d')
  expect(ring.lines()).toEqual(['b', 'c', 'd'])
  ring.clear()
  expect(ring.lines()).toEqual([])
})

test('redactPanelLogLine replaces leftover token assignments', () => {
  expect(redactPanelLogLine('bridge.publish token=s3cret url=http://127.0.0.1:3848')).toBe(
    'bridge.publish token=*** url=http://127.0.0.1:3848'
  )
  expect(redactPanelLogLine('bridge.publish token=***')).toBe('bridge.publish token=***')
})

test('buildPresencePanelSnapshot omits secrets and summarizes activity', () => {
  const snapshot = buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    now: new Date('2026-09-05T06:00:00.000Z'),
    status: statusWith({
      lastActivity: {
        details: 'acme-payments',
        state: 'working',
        assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-working', small_text: 'working' }
      }
    }),
    settings: {
      ...DEFAULT_SETTINGS,
      showBranch: true,
      bridgeEnabled: true,
      bridgeUrl: 'http://100.64.0.2:3848',
      bridgeToken: 'super-secret-token',
      applicationId: SHIPPED_APPLICATION_ID
    },
    logs: ['[chron0.discord-presence] info bridge.publish token=super-secret-token']
  })
  expect(snapshot.version).toBe(PLUGIN_VERSION)
  expect(snapshot.generatedAt).toBe('2026-09-05T06:00:00.000Z')
  expect(snapshot.status.lastActivity).toEqual({ details: 'acme-payments', state: 'working' })
  expect(snapshot.fields.showBranch).toBe(true)
  expect(snapshot.fields.bridgeEnabled).toBe(true)
  expect(snapshot.logs[0]?.includes('token=***')).toBe(true)
  expect(snapshot.logs[0]?.includes('super-secret-token')).toBe(false)
  expect(snapshotLeaksSecrets(snapshot, ['super-secret-token', SHIPPED_APPLICATION_ID])).toBe(false)
  expect(JSON.stringify(snapshot).includes('bridgeToken')).toBe(false)
  expect(JSON.stringify(snapshot).includes('applicationId')).toBe(false)
  expect(JSON.stringify(snapshot).includes('100.64.0.2')).toBe(false)
  expect(JSON.stringify(snapshot).includes('openUrl')).toBe(false)
  expect(snapshot.fields.showOpenButton).toBe(false)
  expect(snapshot.fields.showAgentCount).toBe(false)
  expect(snapshot.fields.showFocusedSurface).toBe(false)
  expect(snapshot.fields.focusedSurfaceDetail).toBe('kind')
  expect(snapshot.fields.showAgentType).toBe(false)
  expect(snapshot.status.sidecarMailbox).toBe(false)
  expect(snapshot.host).toEqual({ sidecar: false, focus: false, executionHost: false })
  expect(formatPanelStatusToast(snapshot)).toBe('enabled=true connected=true sink=local detail=generic')
})

test('buildPresencePanelSnapshot records host probe flags', () => {
  const snapshot = buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    status: statusWith({ sidecarMailbox: true }),
    settings: { ...DEFAULT_SETTINGS, showFocusedSurface: true, focusedSurfaceDetail: 'kind+title' },
    logs: [],
    host: { sidecar: true, focus: true, executionHost: true }
  })
  expect(snapshot.host).toEqual({ sidecar: true, focus: true, executionHost: true })
  expect(snapshot.status.sidecarMailbox).toBe(true)
  expect(snapshot.fields.showFocusedSurface).toBe(true)
  expect(snapshot.fields.focusedSurfaceDetail).toBe('kind+title')
})

test('summarizePanelActivity and conventional log hint', () => {
  expect(summarizePanelActivity(null)).toBe(null)
  expect(CONVENTIONAL_LOG_HINT).toBe('~/.local/state/chron0-discord-presence/plugin.log')
  const emptyFile = buildPresencePanelSnapshot({
    version: '0.4.0',
    status: statusWith({ logFile: null }),
    settings: DEFAULT_SETTINGS,
    logs: []
  })
  expect(emptyFile.logHint).toBe(CONVENTIONAL_LOG_HINT)
})

test('embedPanelSnapshot round-trips JSON and escapes script breakouts', () => {
  const html = readFileSync(panelHtmlPath, 'utf8')
  expect(extractPanelSnapshot(html)).toBe(null)
  const snapshot = buildPresencePanelSnapshot({
    version: '0.4.0',
    status: statusWith(),
    settings: DEFAULT_SETTINGS,
    logs: ['</script><script>alert(1)</script>']
  })
  const embedded = embedPanelSnapshot(html, snapshot)
  expect(embedded.includes('<script>alert(1)')).toBe(false)
  expect(serializePanelSnapshot(snapshot).includes('<')).toBe(false)
  const parsed = extractPanelSnapshot(embedded) as { logs: string[] }
  expect(parsed.logs[0]).toContain('script')
  expect(embedPanelSnapshot(html, null).includes('>null</script>')).toBe(true)
})

test('writePanelSnapshot rewrites a copy and resolvePanelHtmlPath honors env', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-panel-'))
  const dest = join(dir, 'index.html')
  copyFileSync(panelHtmlPath, dest)
  const snapshot = buildPresencePanelSnapshot({
    version: '0.4.0',
    status: statusWith({ connected: false, sink: null }),
    settings: DEFAULT_SETTINGS,
    logs: ['hello']
  })
  expect(writePanelSnapshot(dest, snapshot)).toEqual({ ok: true })
  const parsed = extractPanelSnapshot(readFileSync(dest, 'utf8')) as { status: { connected: boolean } }
  expect(parsed.status.connected).toBe(false)
  expect(writePanelSnapshot(join(dir, 'missing.html'), snapshot).ok).toBe(false)
  expect(resolvePanelHtmlPath({ ORCA_PRESENCE_SKIP_PANEL_WRITE: '1' }, import.meta.url)).toBe(null)
  expect(resolvePanelHtmlPath({ ORCA_PRESENCE_PANEL_HTML: dest }, import.meta.url)).toBe(dest)
  writeFileSync(join(dir, 'broken.html'), '<html></html>')
  expect(writePanelSnapshot(join(dir, 'broken.html'), snapshot)).toEqual({ ok: false, reason: 'no-marker' })
  rmSync(dir, { recursive: true, force: true })
})

test('shipped panel HTML is CSP-safe and speaks the official bridge', () => {
  const html = readFileSync(panelHtmlPath, 'utf8')
  expect(html.includes("type: PANEL_ACTION") || html.includes("'orca-panel-action'")).toBe(true)
  expect(html.includes('orca-panel-action-result')).toBe(true)
  expect(html.includes('orca-panel-ping')).toBe(true)
  expect(html.includes('orca-panel-pong')).toBe(true)
  expect(html.includes('workspace.readContext')).toBe(true)
  expect(html.includes("call('ui.readFocus'")).toBe(true)
  expect(html.includes(' · linked')).toBe(true)
  expect(html.includes('notifications.show')).toBe(true)
  expect(html.includes("call('terminal.sendText'")).toBe(false)
  expect(html.includes("call('settings.set'")).toBe(true)
  expect(html.includes("call('storage.get'")).toBe(true)
  expect(html.includes('diagnostics.snapshot')).toBe(true)
  expect(html.includes('showFocusedSurface')).toBe(true)
  expect(html.includes('fetch(')).toBe(false)
  expect(html.includes(SHIPPED_APPLICATION_ID)).toBe(false)
  expect(html.includes('bridgeToken')).toBe(false)
  expect(html.includes('--background')).toBe(true)
  expect(html.includes('--foreground')).toBe(true)
  expect(html.includes('window.__PRESENCE_PANEL__')).toBe(true)
  expect(html.includes('id="presence-snapshot"')).toBe(true)
  expect(extractPanelSnapshot(html)).toBe(null)
  expect(html.includes("renderSnapshot(value, 'live')")).toBe(true)
  expect(html.includes("renderSnapshot(readSnapshot(), 'bootstrap')")).toBe(true)
  expect(html.includes("renderSnapshot(readSnapshot(), 'refresh')")).toBe(true)
  expect(html.includes("$('logs-box').open = true")).toBe(false)
})

test('shipped panel HTML version markers match PLUGIN_VERSION', () => {
  const html = readFileSync(panelHtmlPath, 'utf8')
  expect(extractPanelVersion(html)).toBe(PLUGIN_VERSION)
  expect(html.includes(`id="version-badge">v${PLUGIN_VERSION}<`)).toBe(true)
  expect(html.includes(`id="about-version">${PLUGIN_VERSION}<`)).toBe(true)
})

test('stampPanelVersion rewrites stale badge, About, and version script', () => {
  const stale = [
    '<script id="plugin-version" type="application/json">"0.4.0"</script>',
    '<span class="badge" id="version-badge">v0.4.0</span>',
    '<dd id="about-version">0.4.0</dd>'
  ].join('')
  const stamped = stampPanelVersion(stale, PLUGIN_VERSION)
  expect(extractPanelVersion(stamped)).toBe(PLUGIN_VERSION)
  expect(stamped.includes(`id="version-badge">v${PLUGIN_VERSION}<`)).toBe(true)
  expect(stamped.includes(`id="about-version">${PLUGIN_VERSION}<`)).toBe(true)
  expect(stamped.includes('0.4.0')).toBe(false)
})

test('embedPanelSnapshot stamps snapshot.version and null uses PLUGIN_VERSION', () => {
  const html = readFileSync(panelHtmlPath, 'utf8')
  const snapshot = buildPresencePanelSnapshot({
    version: '9.9.9',
    status: statusWith(),
    settings: DEFAULT_SETTINGS,
    logs: []
  })
  const withSnap = embedPanelSnapshot(html, snapshot)
  expect(extractPanelVersion(withSnap)).toBe('9.9.9')
  expect(withSnap.includes('id="version-badge">v9.9.9<')).toBe(true)
  expect(withSnap.includes('id="about-version">9.9.9<')).toBe(true)
  const withNull = embedPanelSnapshot(html, null)
  expect(extractPanelVersion(withNull)).toBe(PLUGIN_VERSION)
  expect(withNull.includes(`id="version-badge">v${PLUGIN_VERSION}<`)).toBe(true)
})
