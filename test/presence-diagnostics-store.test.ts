import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/presence/settings'
import {
  capPanelSnapshotForStorage,
  DIAGNOSTICS_STORAGE_KEY,
  MAX_PANEL_STORAGE_JSON_BYTES,
  parseStoredPanelSnapshot,
  writeDiagnosticsSnapshot
} from '../src/presence/diagnostics-store'
import { buildPresencePanelSnapshot } from '../src/presence/panel-snapshot'
import { PLUGIN_VERSION } from '../src/version'
import type { PresenceStatus } from '../src/presence/controller'

function statusWith(overrides: Partial<PresenceStatus> = {}): PresenceStatus {
  return {
    enabled: true,
    connected: true,
    bridgeEnabled: false,
    sink: 'local',
    detailLevel: 'generic',
    lastActivity: {
      details: 'Working in Orca',
      assets: {
        large_image: 'orca',
        large_text: 'Orca',
        small_image: 'state-idle',
        small_text: 'idle'
      }
    },
    logFile: '/tmp/plugin.log',
    sidecarMailbox: false,
    heldClear: false,
    ...overrides
  }
}

function snapshotWith(logs: string[]) {
  return buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    status: statusWith(),
    settings: DEFAULT_SETTINGS,
    logs
  })
}

test('DIAGNOSTICS_STORAGE_KEY is the mailbox name', () => {
  expect(DIAGNOSTICS_STORAGE_KEY).toBe('diagnostics.snapshot')
})

test('capPanelSnapshotForStorage leaves a small snapshot alone', () => {
  const snapshot = snapshotWith(['a', 'b'])
  expect(capPanelSnapshotForStorage(snapshot)).toEqual(snapshot)
})

test('capPanelSnapshotForStorage shrinks a huge log tail under the 60 KiB cap', () => {
  const huge = snapshotWith(Array.from({ length: 400 }, () => 'x'.repeat(400)))
  expect(Buffer.byteLength(JSON.stringify(huge), 'utf8')).toBeGreaterThan(MAX_PANEL_STORAGE_JSON_BYTES)
  const capped = capPanelSnapshotForStorage(huge)
  expect(Buffer.byteLength(JSON.stringify(capped), 'utf8')).toBeLessThanOrEqual(
    MAX_PANEL_STORAGE_JSON_BYTES
  )
  expect(capped.logs.length).toBeLessThan(huge.logs.length)
})

test('parseStoredPanelSnapshot accepts a real snapshot and rejects junk', () => {
  const snapshot = snapshotWith(['hello'])
  expect(parseStoredPanelSnapshot(snapshot)).toEqual(snapshot)
  expect(parseStoredPanelSnapshot(null)).toBeNull()
  expect(parseStoredPanelSnapshot({ version: 1 })).toBeNull()
  expect(parseStoredPanelSnapshot({ version: '0.6.0' })).toBeNull()
})

test('writeDiagnosticsSnapshot posts the capped snapshot and swallows host misses', async () => {
  const written: Array<{ key?: unknown; value?: unknown }> = []
  const snapshot = snapshotWith(['line'])
  const ok = await writeDiagnosticsSnapshot(async (method, args) => {
    expect(method).toBe('storage.set')
    written.push(args ?? {})
    return { ok: true }
  }, snapshot)
  expect(ok).toBe(true)
  expect(written[0]?.key).toBe(DIAGNOSTICS_STORAGE_KEY)
  expect(parseStoredPanelSnapshot(written[0]?.value)).not.toBeNull()

  const missed = await writeDiagnosticsSnapshot(async () => {
    throw new Error('no such method')
  }, snapshot)
  expect(missed).toBe(false)
})
