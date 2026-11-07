import { expect, test } from 'bun:test'
import type { CanonicalAgentState } from '../src/presence/agent-state'
import type { PresenceStatus } from '../src/presence/controller'
import { normalizeSettings } from '../src/presence/settings'
import { formatDuration, renderStatusBar } from '../src/presence/status-bar'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

type Input = {
  status?: Partial<PresenceStatus>
  settings?: Record<string, unknown>
  agentState?: CanonicalAgentState
  agentCount?: number
  elapsedStartMs?: number
}

function render({ status, settings, agentState, agentCount = 1, elapsedStartMs }: Input = {}) {
  return renderStatusBar({
    status: {
      enabled: true,
      connected: true,
      heldClear: false,
      sink: 'local',
      lastActivity: { details: 'Working on orca', assets: {} },
      ...status
    } as PresenceStatus,
    settings: normalizeSettings({
      detailLevel: 'workspace',
      showAgentState: true,
      showAgentCount: true,
      showStatusBar: true,
      ...settings
    }),
    agentState,
    agentCount,
    elapsedStartMs,
    nowMs: NOW
  })
}

test.each<[string, Input, string, string, string]>([
  ['working, 1 agent', { agentState: 'working', agentCount: 1 }, 'Working', 'accent', 'activity'],
  ['working, 3 agents', { agentState: 'working', agentCount: 3 }, 'Working · 3', 'accent', 'activity'],
  [
    '3 agents, count hidden',
    { agentState: 'working', agentCount: 3, settings: { showAgentCount: false } },
    'Working',
    'accent',
    'activity'
  ],
  ['blocked', { agentState: 'blocked' }, 'Blocked', 'danger', 'activity'],
  ['waiting', { agentState: 'waiting' }, 'Waiting', 'warning', 'activity'],
  ['done', { agentState: 'done' }, 'Done', 'success', 'activity'],
  ['idle, connected', {}, 'Discord', 'neutral', 'activity'],
  [
    'state hidden',
    { agentState: 'working', settings: { showAgentState: false } },
    'Discord',
    'neutral',
    'activity'
  ],
  ['disabled', { agentState: 'working', status: { enabled: false } }, 'Discord off', 'neutral', 'activity'],
  [
    'detail off',
    { agentState: 'working', settings: { detailLevel: 'off' } },
    'Discord off',
    'neutral',
    'activity'
  ],
  ['clear hold', { agentState: 'working', status: { heldClear: true } }, 'Discord off', 'neutral', 'activity'],
  [
    'not connected',
    { agentState: 'working', status: { connected: false, sink: null } },
    'Discord',
    'warning',
    'warning'
  ],
  [
    'via bridge',
    { agentState: 'working', status: { connected: false, sink: 'bridge' } },
    'Working',
    'accent',
    'activity'
  ]
])('%s', (_name, input, text, tone, icon) => {
  const patch = render(input)
  expect(patch).toMatchObject({ id: 'presence', text, tone, icon, visible: true })
})

test('tooltip carries details, elapsed time and sink', () => {
  const patch = render({ agentState: 'working', elapsedStartMs: NOW - (2 * 60 + 14) * MINUTE })
  expect(patch.tooltip).toBe(
    'Discord: Working on orca · 2h 14m · connected via local. Click to show or hide the panel.'
  )
})

test('tooltip when off has no details', () => {
  for (const input of [
    { status: { enabled: false } },
    { status: { heldClear: true } },
    { settings: { detailLevel: 'off' } }
  ]) {
    expect(render({ agentState: 'working', ...input }).tooltip).toBe(
      'Discord: off. Click to show or hide the panel.'
    )
  }
})

test('tooltip when not connected', () => {
  const patch = render({ agentState: 'working', status: { connected: false, sink: null } })
  expect(patch.tooltip).toBe(
    'Discord: Working on orca · not connected. Click to show or hide the panel.'
  )
})

test('tooltip omits time when showElapsed is off', () => {
  const patch = render({ settings: { showElapsed: false }, elapsedStartMs: NOW - 5 * MINUTE })
  expect(patch.tooltip).toBe('Discord: Working on orca · connected via local. Click to show or hide the panel.')
})

test('showStatusBar false hides the item', () => {
  expect(render({ settings: { showStatusBar: false } }).visible).toBe(false)
})

test('formatDuration', () => {
  expect(formatDuration(0)).toBe('<1m')
  expect(formatDuration(59_000)).toBe('<1m')
  expect(formatDuration(14 * MINUTE)).toBe('14m')
  expect(formatDuration((2 * 60 + 14) * MINUTE)).toBe('2h 14m')
  expect(formatDuration(3 * 3_600_000)).toBe('3h 0m')
})
