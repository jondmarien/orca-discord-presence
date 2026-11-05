import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildActivity, localAssetName } from '../src/presence/activity'
import { normalizeSettings } from '../src/presence/settings'

const SNAPSHOT = {
  displayName: 'acme-payments',
  branch: 'feat/refund-flow',
  terminalCount: 3,
  agentState: 'working',
  stateStartedAtMs: 1_700_000_000_000,
  machineName: 'jon-desktop'
}

const NOW_MS = 1_700_000_060_000

function settingsWith(overrides: Record<string, unknown>) {
  return normalizeSettings({ ...overrides })
}

test('detail level off produces no activity at all', () => {
  const activity = buildActivity(SNAPSHOT, settingsWith({ detailLevel: 'off' }), NOW_MS)
  expect(activity).toBeNull()
})

test('disabled produces no activity even at full detail', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ enabled: false, detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity).toBeNull()
})

test('generic leaks no workspace, branch, or machine name', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'generic', showBranch: true, showMachine: true }),
    NOW_MS
  )
  const serialized = JSON.stringify(activity)
  expect(activity?.details).toBe('Working in Orca')
  expect(serialized.includes('acme-payments')).toBe(false)
  expect(serialized.includes('refund-flow')).toBe(false)
  expect(serialized.includes('jon-desktop')).toBe(false)
})

test('workspace level shows the workspace name but never the branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'workspace', showBranch: true }),
    NOW_MS
  )
  expect(activity?.details).toBe('acme-payments')
  expect(JSON.stringify(activity).includes('refund-flow')).toBe(false)
})

test('full level with showBranch renders workspace and branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showBranch: true }),
    NOW_MS
  )
  expect(activity?.details).toBe('acme-payments — feat/refund-flow')
})

test('full level without showBranch omits the branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showBranch: false }),
    NOW_MS
  )
  expect(activity?.details).toBe('acme-payments')
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
  expect(activity?.state).toBe('working · 3 terminals · jon-desktop')
})

test('a single terminal is not pluralized', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, terminalCount: 1 },
    settingsWith({ detailLevel: 'full', showAgentState: false, showTerminals: true }),
    NOW_MS
  )
  expect(activity?.state).toBe('1 terminal')
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
  expect(activity?.state).toBe('work-laptop')
})

test('agent state done renders as completed with the completed asset', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'done' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.state).toBe('completed')
  expect(activity?.assets.small_image).toBe('state-completed-v2')
  expect(activity?.assets.small_text).toBe('completed')
})

test('no agent state renders as idle with the idle asset', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: undefined },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.state).toBe('idle')
  expect(activity?.assets.small_image).toBe('state-idle-v2')
  expect(activity?.assets.small_text).toBe('idle')
})

test('an unrecognized agent state never leaks verbatim', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'exfiltrating-secrets' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.state).toBe('completed')
  expect(activity?.assets.small_image).toBe('state-completed-v2')
})

test('showElapsed emits unix seconds, not milliseconds', () => {
  const activity = buildActivity(SNAPSHOT, settingsWith({ detailLevel: 'full' }), NOW_MS)
  expect(activity?.timestamps?.start).toBe(Math.floor(SNAPSHOT.stateStartedAtMs / 1000))
})

test('showElapsed disabled omits timestamps entirely', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showElapsed: false }),
    NOW_MS
  )
  expect(activity && 'timestamps' in activity).toBe(false)
})

test('a future start timestamp is clamped to now', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, stateStartedAtMs: NOW_MS + 60_000 },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.timestamps?.start).toBe(Math.floor(NOW_MS / 1000))
})

test('over-long names are truncated to discord limits', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, displayName: 'x'.repeat(400) },
    settingsWith({ detailLevel: 'workspace' }),
    NOW_MS
  )
  expect((activity?.details.length ?? 0) <= 128).toBe(true)
})

test('running aliases to the working asset and label', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'running' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.state).toBe('working')
  expect(activity?.assets.small_image).toBe('state-working-v2')
  expect(activity?.assets.small_text).toBe('working')
})

test('needs_input aliases to waiting for input', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'needs_input' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.state).toBe('waiting for input')
  expect(activity?.assets.small_image).toBe('state-waiting-v2')
})

test('an unrecognized agent state is omitted from the serialized payload', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'exfiltrating-secrets' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  const serialized = JSON.stringify(activity)
  expect(activity?.state).toBe('completed')
  expect(serialized.includes('exfiltrating-secrets')).toBe(false)
})

test('an https openUrl with showOpenButton attaches one Discord button', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({
      detailLevel: 'generic',
      showOpenButton: true,
      openUrl: 'https://orca.example/docs',
      openButtonLabel: 'Open Orca'
    }),
    NOW_MS
  )
  expect(activity?.buttons).toEqual([{ label: 'Open Orca', url: 'https://orca.example/docs' }])
})

test('buttons are omitted without a flag or https URL', () => {
  const noFlag = buildActivity(
    SNAPSHOT,
    settingsWith({ openUrl: 'https://orca.example', showOpenButton: false }),
    NOW_MS
  )
  expect(noFlag && 'buttons' in noFlag).toBe(false)
  const noUrl = buildActivity(SNAPSHOT, settingsWith({ showOpenButton: true, openUrl: '' }), NOW_MS)
  expect(noUrl && 'buttons' in noUrl).toBe(false)
})

test('showAgentCount prefixes the state line', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentCount: 2 },
    settingsWith({ detailLevel: 'full', showAgentState: true, showAgentCount: true }),
    NOW_MS
  )
  expect(activity?.state).toBe('2 agents · working')
})

test('a single agent is not pluralized when the count is shown', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentCount: 1, agentState: 'blocked' },
    settingsWith({
      detailLevel: 'full',
      showAgentState: true,
      showAgentCount: true,
      showTerminals: false,
      showMachine: false
    }),
    NOW_MS
  )
  expect(activity?.state).toBe('1 agent · blocked')
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
  expect(activity && 'state' in activity).toBe(false)
})

test('every Discord asset key carries the -v2 suffix and maps back to a local file', () => {
  const activity = buildActivity({ ...SNAPSHOT, agentState: 'blocked' }, normalizeSettings({}), NOW_MS)
  expect(activity?.assets.large_image).toBe('orca-v2')
  expect(activity?.assets.small_image).toBe('state-blocked-v2')
  expect(localAssetName('state-blocked-v2')).toBe('state-blocked')
  expect(existsSync(join(import.meta.dir, '..', 'assets', `${localAssetName(activity!.assets.small_image)}.png`))).toBe(true)
})
