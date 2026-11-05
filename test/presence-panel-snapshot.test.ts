import { expect, test } from 'bun:test'
import { SHIPPED_APPLICATION_ID, DEFAULT_SETTINGS } from '../src/presence/settings'
import { createLogRing } from '../src/presence/log-ring'
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

function statusWith(overrides: Partial<PresenceStatus> = {}): PresenceStatus {
  return {
    enabled: true,
    connected: true,
    bridgeEnabled: false,
    sink: 'local',
    detailLevel: 'generic',
    lastActivity: { details: 'Working in Orca', assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-idle', small_text: 'idle' } },
    logFile: '/tmp/plugin.log',
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
    logs: ['[jondmarien.discord-presence] info bridge.publish token=super-secret-token']
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
  expect(formatPanelStatusToast(snapshot)).toBe('enabled=true connected=true sink=local detail=generic')
})

test('summarizePanelActivity and conventional log hint', () => {
  expect(summarizePanelActivity(null)).toBe(null)
  expect(CONVENTIONAL_LOG_HINT).toBe('~/.local/state/jondmarien-discord-presence/plugin.log')
  const emptyFile = buildPresencePanelSnapshot({
    version: '0.4.0',
    status: statusWith({ logFile: null }),
    settings: DEFAULT_SETTINGS,
    logs: []
  })
  expect(emptyFile.logHint).toBe(CONVENTIONAL_LOG_HINT)
})
