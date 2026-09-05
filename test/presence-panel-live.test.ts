import { expect, test } from 'bun:test'
import {
  fingerprintPanelSnapshot,
  panelRenderPolicy,
  shouldRewritePanelHtml
} from '../src/presence/panel-live'

test('live and refresh polls never stomp field toggles or force logs open', () => {
  expect(panelRenderPolicy('live')).toEqual({ applyFields: false, forceLogsOpen: false })
  expect(panelRenderPolicy('refresh')).toEqual({ applyFields: false, forceLogsOpen: false })
})

test('bootstrap may seed toggles from the embedded snapshot but still leaves logs collapsed', () => {
  expect(panelRenderPolicy('bootstrap')).toEqual({ applyFields: true, forceLogsOpen: false })
})

test('fingerprintPanelSnapshot ignores generatedAt so heartbeat timestamps do not count as a change', () => {
  const a = { version: '0.6.2', generatedAt: '2026-09-05T09:13:04.848Z', logs: ['one'], status: { enabled: true } }
  const b = { version: '0.6.2', generatedAt: '2026-09-05T09:13:06.848Z', logs: ['one'], status: { enabled: true } }
  const c = { version: '0.6.2', generatedAt: '2026-09-05T09:13:04.848Z', logs: ['two'], status: { enabled: true } }
  expect(fingerprintPanelSnapshot(a)).toBe(fingerprintPanelSnapshot(b))
  expect(fingerprintPanelSnapshot(a)).not.toBe(fingerprintPanelSnapshot(c))
})

test('shouldRewritePanelHtml is false once storage.set accepted the snapshot', () => {
  expect(shouldRewritePanelHtml(true)).toBe(false)
  expect(shouldRewritePanelHtml(false)).toBe(true)
})
