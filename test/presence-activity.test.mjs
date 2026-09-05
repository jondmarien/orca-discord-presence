import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSettings } from '../src/presence-settings.mjs'
import { buildActivity } from '../src/presence-activity.mjs'

const SNAPSHOT = {
  displayName: 'acme-payments',
  branch: 'feat/refund-flow',
  terminalCount: 3,
  agentState: 'working',
  stateStartedAtMs: 1_700_000_000_000,
  machineName: 'jon-desktop'
}

const NOW_MS = 1_700_000_060_000

function settingsWith(overrides) {
  return normalizeSettings({ ...overrides })
}

test('detail level off produces no activity at all', () => {
  const activity = buildActivity(SNAPSHOT, settingsWith({ detailLevel: 'off' }), NOW_MS)
  assert.equal(activity, null)
})

test('disabled produces no activity even at full detail', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ enabled: false, detailLevel: 'full' }),
    NOW_MS
  )
  assert.equal(activity, null)
})

test('generic leaks no workspace, branch, or machine name', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'generic', showBranch: true, showMachine: true }),
    NOW_MS
  )
  const serialized = JSON.stringify(activity)
  assert.equal(activity.details, 'Working in Orca')
  assert.equal(serialized.includes('acme-payments'), false)
  assert.equal(serialized.includes('refund-flow'), false)
  assert.equal(serialized.includes('jon-desktop'), false)
})

test('workspace level shows the workspace name but never the branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'workspace', showBranch: true }),
    NOW_MS
  )
  assert.equal(activity.details, 'acme-payments')
  assert.equal(JSON.stringify(activity).includes('refund-flow'), false)
})

test('full level with showBranch renders workspace and branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showBranch: true }),
    NOW_MS
  )
  assert.equal(activity.details, 'acme-payments — feat/refund-flow')
})

test('full level without showBranch omits the branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showBranch: false }),
    NOW_MS
  )
  assert.equal(activity.details, 'acme-payments')
})

test('state combines agent state, terminals, and machine when enabled', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({
      detailLevel: 'full',
      showAgentState: true,
      showTerminals: true,
      showMachine: true
    }),
    NOW_MS
  )
  assert.equal(activity.state, 'working · 3 terminals · jon-desktop')
})

test('a single terminal is not pluralized', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, terminalCount: 1 },
    settingsWith({ detailLevel: 'full', showAgentState: false, showTerminals: true }),
    NOW_MS
  )
  assert.equal(activity.state, '1 terminal')
})

test('machineLabel overrides the detected machine name', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({
      detailLevel: 'full',
      showAgentState: false,
      showMachine: true,
      machineLabel: 'work-laptop'
    }),
    NOW_MS
  )
  assert.equal(activity.state, 'work-laptop')
})

test('agent state done renders as idle with the idle asset', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'done' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  assert.equal(activity.state, 'idle')
  assert.equal(activity.assets.small_image, 'state-idle')
})

test('an unrecognized agent state falls back to idle rather than leaking it', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'exfiltrating-secrets' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  assert.equal(activity.state, 'idle')
  assert.equal(activity.assets.small_image, 'state-idle')
})

test('showElapsed emits unix seconds, not milliseconds', () => {
  const activity = buildActivity(SNAPSHOT, settingsWith({ detailLevel: 'full' }), NOW_MS)
  assert.equal(activity.timestamps.start, Math.floor(SNAPSHOT.stateStartedAtMs / 1000))
})

test('showElapsed disabled omits timestamps entirely', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showElapsed: false }),
    NOW_MS
  )
  assert.equal('timestamps' in activity, false)
})

test('a future start timestamp is clamped to now', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, stateStartedAtMs: NOW_MS + 60_000 },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  assert.equal(activity.timestamps.start, Math.floor(NOW_MS / 1000))
})

test('over-long names are truncated to discord limits', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, displayName: 'x'.repeat(400) },
    settingsWith({ detailLevel: 'workspace' }),
    NOW_MS
  )
  assert.ok(activity.details.length <= 128)
})

test('an empty state string is omitted rather than sent blank', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({
      detailLevel: 'full',
      showAgentState: false,
      showTerminals: false,
      showMachine: false
    }),
    NOW_MS
  )
  assert.equal('state' in activity, false)
})
