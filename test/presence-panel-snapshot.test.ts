import { expect, test } from 'bun:test'
import { SHIPPED_APPLICATION_ID, DEFAULT_SETTINGS } from '../src/presence/settings'
import { createLogRing } from '../src/presence/log-ring'
import {
  buildPresencePanelSnapshot,
  CONVENTIONAL_LOG_HINT,
  formatPanelStatusToast,
  redactPanelLogLine,
  snapshotLeaksSecrets,
  summarizePanelActivity,
  summarizePanelAgents
} from '../src/presence/panel-snapshot'
import { PLUGIN_VERSION } from '../src/version'
import type { PresenceStatus } from '../src/presence/controller'

function statusWith(overrides: Partial<PresenceStatus> = {}): PresenceStatus {
  return {
    enabled: true,
    connected: true,
    client: null,
    clients: [],
    clientFallback: false,
    bridgeEnabled: false,
    sink: 'local',
    detailLevel: 'generic',
    lastActivity: { details: 'Working in Orca', assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-idle', small_text: 'idle' } },
    logFile: '/tmp/plugin.log',
    heldClear: false,
    bridgeFailing: false,
    localFailing: false,
    ...overrides
  }
}

test('agent rows sort blocked, waiting, working, then done (completed)', () => {
  const slot = (state: 'working' | 'blocked' | 'waiting' | 'done', receivedAt: number) =>
    ({ workspaceId: 'w', paneKey: String(receivedAt), canonicalState: state, receivedAt }) as never
  const rows = summarizePanelAgents([slot('done', 1), slot('working', 2), slot('blocked', 3), slot('waiting', 4)])
  expect(rows.map((r) => r.state)).toEqual(['blocked', 'waiting', 'working', 'done'])
})

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

test('snapshot carries client info with no socket path anywhere', () => {
  for (const path of ['/run/user/1000/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-0', '\\\\?\\pipe\\discord-ipc-0']) {
    const snapshot = buildPresencePanelSnapshot({
      version: PLUGIN_VERSION,
      status: statusWith({
        client: { id: 'vesktop:0', label: 'Vesktop' },
        // A careless caller handing paths through must still not leak them.
        clients: [{ id: 'vesktop:0', label: 'Vesktop', path } as never],
        clientFallback: true
      }),
      settings: { ...DEFAULT_SETTINGS, discordClient: 'vesktop:0' },
      logs: [],
      timeline: [],
      agents: []
    })
    expect(snapshot.status.client).toEqual({ id: 'vesktop:0', label: 'Vesktop' })
    expect(snapshot.status.clients).toEqual([{ id: 'vesktop:0', label: 'Vesktop' }])
    expect(snapshot.status.clientFallback).toBe(true)
    expect(snapshot.fields.discordClient).toBe('vesktop:0')
    expect('path' in snapshot.status.clients[0]).toBe(false)
    const json = JSON.stringify(snapshot)
    expect(json.includes('/run/user')).toBe(false)
    expect(json.includes('\\\\pipe')).toBe(false)
  }
})

test('toast includes the connected client id', () => {
  const snapshot = buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    status: statusWith({ client: { id: 'vesktop:0', label: 'Vesktop' } }),
    settings: DEFAULT_SETTINGS,
    logs: [],
    timeline: [],
    agents: []
  })
  expect(formatPanelStatusToast(snapshot)).toContain('client=vesktop:0')
  snapshot.status.client = null
  expect(formatPanelStatusToast(snapshot)).toContain('client=none')
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
    timeline: [],
    agents: [],
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
  expect(formatPanelStatusToast(snapshot)).toBe('enabled=true connected=true client=none sink=local detail=generic')
})

test('summarizePanelActivity and conventional log hint', () => {
  expect(summarizePanelActivity(null)).toBe(null)
  expect(CONVENTIONAL_LOG_HINT).toBe('~/.local/state/jondmarien-discord-presence/plugin.log')
  const emptyFile = buildPresencePanelSnapshot({
    version: '0.4.0',
    status: statusWith({ logFile: null }),
    settings: DEFAULT_SETTINGS,
    timeline: [],
    agents: [],
    logs: []
  })
  expect(emptyFile.logHint).toBe(CONVENTIONAL_LOG_HINT)
})

test('snapshot agents expose only kind/state/sinceMs', () => {
  const snapshot = buildPresencePanelSnapshot({
    version: '1.0.0',
    status: statusWith(),
    settings: DEFAULT_SETTINGS,
    timeline: [['idle'], null, ['working', 'completed']],
    logs: [],
    agents: [
      { workspaceId: 'secret-ws', paneKey: 'secret-pane', terminalId: 'term-secret', rawState: 'running', canonicalState: 'working', receivedAt: 200 },
      { workspaceId: '', paneKey: '', rawState: 'x', canonicalState: 'blocked', receivedAt: 500, kind: 'codex' },
      { workspaceId: '', paneKey: '', rawState: 'x', canonicalState: 'working', receivedAt: 100, kind: 'claude' }
    ]
  })
  for (const row of snapshot.agents) {
    expect(Object.keys(row)).toEqual(['kind', 'state', 'sinceMs'])
  }
  expect(snapshot.agents).toEqual([
    { kind: 'codex', state: 'blocked', sinceMs: 500 },
    { kind: 'claude', state: 'working', sinceMs: 100 },
    { kind: 'agent', state: 'working', sinceMs: 200 }
  ])
  expect(snapshot.timeline).toEqual([['idle'], null, ['working', 'completed']])
  expect(snapshotLeaksSecrets(snapshot, ['secret-ws', 'secret-pane', 'term-secret'])).toBe(false)
})

test('snapshot agent rows carry the chat title, truncated to 80 characters', () => {
  const long = 'x'.repeat(200)
  const rows = summarizePanelAgents([
    { workspaceId: 'w', paneKey: '1', rawState: 'x', canonicalState: 'working', receivedAt: 1, kind: 'claude', title: 'Fix login bug' },
    { workspaceId: 'w', paneKey: '2', rawState: 'x', canonicalState: 'working', receivedAt: 2, kind: 'codex', title: long },
    { workspaceId: 'w', paneKey: '3', rawState: 'x', canonicalState: 'working', receivedAt: 3, kind: 'codex', title: '   ' }
  ])
  expect(rows[0]).toEqual({ kind: 'claude', title: 'Fix login bug', state: 'working', sinceMs: 1 })
  expect(rows[1]?.title).toHaveLength(80)
  expect(rows[1]?.title?.endsWith('…')).toBe(true)
  expect(rows[2]).not.toHaveProperty('title')
})

test('activityCard maps keys and ms timestamp', () => {
  const base = { version: '1.0.0', settings: DEFAULT_SETTINGS, timeline: [], agents: [], logs: [] }
  const card = buildPresencePanelSnapshot({
    ...base,
    status: statusWith({
      lastActivity: {
        details: 'acme',
        state: 'claude',
        timestamps: { start: 1_700_000_000 },
        assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-working', small_text: 'working' }
      }
    })
  }).activityCard
  expect(card).toEqual({
    details: 'acme',
    state: 'claude',
    largeImageKey: 'orca',
    smallImageKey: 'state-working',
    startMs: 1_700_000_000_000
  })
  expect(buildPresencePanelSnapshot({ ...base, status: statusWith({ lastActivity: null }) }).activityCard).toBe(null)
  expect(buildPresencePanelSnapshot({ ...base, status: statusWith() }).activityCard?.startMs).toBe(null)
})

test('snapshot carries the hidden panel ids from settings', () => {
  const build = (hiddenPanels: string) =>
    buildPresencePanelSnapshot({
      version: PLUGIN_VERSION,
      status: statusWith({}),
      settings: { ...DEFAULT_SETTINGS, hiddenPanels },
      logs: [],
      timeline: [],
      agents: []
    })
  expect(build('strip,logs').hidden).toEqual(['strip', 'logs'])
  expect(build('').hidden).toEqual([])
})

test('snapshot carries taskTitle, failure/interruption outcome, opaque focusKey, hostKind, order, and leaderboards', () => {
  const snapshot = buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    status: statusWith({}),
    settings: {
      ...DEFAULT_SETTINGS,
      showLeaderboards: true,
      panelOrder: 'agents,preview,actions,strip,tiles,sink,client,detail,toggles,leaderboards,logs'
    },
    logs: [],
    timeline: [],
    hostKind: 'ssh',
    leaderboardRows: [{ name: 'orca-discord-presence', messages: 42, tokens: 120_000 }],
    focusKeyOf: (slot) => (slot.terminalId ? `k:${slot.terminalId === 'term-real' ? '0' : '1'}` : undefined),
    agents: [
      {
        workspaceId: 'ws-secret',
        paneKey: 'pane-secret',
        terminalId: 'term-real',
        rawState: 'done',
        canonicalState: 'done',
        receivedAt: 100,
        kind: 'claude',
        taskTitle: 'x'.repeat(120),
        outcome: 'failure'
      },
      {
        workspaceId: 'ws-secret',
        paneKey: 'pane-2',
        sessionId: 'sess-only',
        rawState: 'done',
        canonicalState: 'done',
        receivedAt: 200,
        kind: 'codex',
        outcome: 'success'
      }
    ]
  })
  expect(snapshot.status.hostKind).toBe('ssh')
  expect(snapshot.order[0]).toBe('agents')
  expect(snapshot.leaderboards).toEqual({
    enabled: true,
    rows: [{ name: 'orca-discord-presence', messages: 42, tokens: 120_000 }]
  })
  expect(snapshot.agents[0]?.taskTitle).toHaveLength(80)
  expect(snapshot.agents[0]?.outcome).toBe('failure')
  expect(snapshot.agents[0]?.focusKey).toBe('k:0')
  expect(snapshot.agents[1]?.outcome).toBeUndefined()
  expect(snapshot.agents[1]?.focusKey).toBeUndefined()
  expect(snapshotLeaksSecrets(snapshot, ['ws-secret', 'pane-secret', 'term-real', 'sess-only'])).toBe(false)

  // Disabled leaderboards always emits empty rows even if rows were passed in.
  const disabled = buildPresencePanelSnapshot({
    version: PLUGIN_VERSION,
    status: statusWith({}),
    settings: { ...DEFAULT_SETTINGS, showLeaderboards: false },
    logs: [],
    timeline: [],
    leaderboardRows: [{ name: 'secret-ws', messages: 10, tokens: 5000 }],
    agents: []
  })
  expect(disabled.leaderboards).toEqual({ enabled: false, rows: [] })
})
