import { expect, test } from 'bun:test'
import { buildActivity } from '../src/presence/activity'
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

test('agent state done renders as idle with the idle asset', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'done' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.state).toBe('idle')
  expect(activity?.assets.small_image).toBe('state-idle')
})

test('an unrecognized agent state falls back to idle rather than leaking it', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'exfiltrating-secrets' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.state).toBe('idle')
  expect(activity?.assets.small_image).toBe('state-idle')
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
  expect(activity?.assets.small_image).toBe('state-working')
  expect(activity?.assets.small_text).toBe('working')
})

test('needs_input aliases to waiting for input', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'needs_input' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  expect(activity?.state).toBe('waiting for input')
  expect(activity?.assets.small_image).toBe('state-waiting')
})

test('an unrecognized agent state is omitted from the serialized payload', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'exfiltrating-secrets' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  const serialized = JSON.stringify(activity)
  expect(activity?.state).toBe('idle')
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

test('generic never leaks execution host, agent identity, or focus title', () => {
  const activity = buildActivity(
    {
      ...SNAPSHOT,
      machineName: 'ssh-box',
      agentType: 'claude',
      agentModel: 'opus',
      agentProfile: 'review',
      focusedSurfaceKind: 'editor',
      focusedSurfaceTitle: 'secrets.ts',
      focusedSurfaceAtMs: NOW_MS
    },
    settingsWith({
      detailLevel: 'generic',
      showMachine: true,
      showAgentType: true,
      showAgentModel: true,
      showAgentProfile: true,
      showFocusedSurface: true,
      focusedSurfaceDetail: 'kind+title'
    }),
    NOW_MS
  )
  const serialized = JSON.stringify(activity)
  expect(activity?.details).toBe('Working in Orca')
  expect(serialized.includes('ssh-box')).toBe(false)
  expect(serialized.includes('claude')).toBe(false)
  expect(serialized.includes('opus')).toBe(false)
  expect(serialized.includes('review')).toBe(false)
  expect(serialized.includes('secrets.ts')).toBe(false)
  expect(serialized.includes('Editor')).toBe(false)
  expect(serialized.includes('worktreeId')).toBe(false)
  expect(serialized.includes('agentId')).toBe(false)
})

test('full detail can include focus, agent identity, and execution-host machine', () => {
  const activity = buildActivity(
    {
      ...SNAPSHOT,
      machineName: 'omarchy-box',
      agentType: 'claude',
      agentModel: 'opus',
      agentProfile: 'review',
      focusedSurfaceKind: 'terminal',
      focusedSurfaceTitle: 'zsh',
      focusedSurfaceAtMs: NOW_MS,
      agentState: 'working'
    },
    settingsWith({
      detailLevel: 'full',
      showAgentState: true,
      showAgentType: true,
      showAgentModel: true,
      showAgentProfile: true,
      showFocusedSurface: true,
      focusedSurfaceDetail: 'kind+title',
      showMachine: true,
      showTerminals: false
    }),
    NOW_MS
  )
  expect(activity?.state).toBe('Terminal · zsh · claude · opus · review · working · omarchy-box')
})

test('workspace detail shows focus kind only and never agent identity', () => {
  const activity = buildActivity(
    {
      ...SNAPSHOT,
      agentType: 'claude',
      focusedSurfaceKind: 'agent',
      focusedSurfaceTitle: 'Claude',
      focusedSurfaceAtMs: NOW_MS
    },
    settingsWith({
      detailLevel: 'workspace',
      showAgentState: false,
      showAgentType: true,
      showFocusedSurface: true,
      focusedSurfaceDetail: 'kind+title',
      showTerminals: false,
      showMachine: false
    }),
    NOW_MS
  )
  expect(activity?.state).toBe('Agent')
  expect(JSON.stringify(activity).includes('claude')).toBe(false)
})
