import { expect, test } from 'bun:test'
import { AGENT_RETENTION_MS } from '../src/presence/expiry'
import {
  createAgentTable,
  paneKeyMatchesAgentId,
  parseAgentStatusPayload,
  parseWorktreeRemovedId
} from '../src/presence/agents'

type FakeTimer = {
  fn: () => void | Promise<void>
  at: number
  cancelled: boolean
}

function tableHarness() {
  let now = 1_000_000
  const timers: FakeTimer[] = []
  const changes: number[] = []
  const table = createAgentTable({
    now: () => now,
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { fn, at: now + ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      if (timer && typeof timer === 'object' && 'cancelled' in timer) {
        ;(timer as FakeTimer).cancelled = true
      }
    },
    onChange: () => {
      changes.push(now)
    }
  })
  const advance = async (ms: number) => {
    now += ms
    for (const timer of [...timers]) {
      if (!timer.cancelled && timer.at <= now) {
        timer.cancelled = true
        await timer.fn()
      }
    }
  }
  return { table, advance, nowRef: () => now, changes }
}

test('parseAgentStatusPayload reads worktreeId, paneKey, state, and receivedAt', () => {
  const parsed = parseAgentStatusPayload(
    {
      worktreeId: 'repo::/tmp/a',
      paneKey: 'tab:one',
      state: 'running',
      receivedAt: 1_700_000_000_000
    },
    9
  )
  expect(parsed).toEqual({
    worktreeId: 'repo::/tmp/a',
    paneKey: 'tab:one',
    state: 'running',
    receivedAt: 1_700_000_000_000
  })
})

test('parseAgentStatusPayload fills missing ids and receivedAt', () => {
  const parsed = parseAgentStatusPayload({ state: 'working' }, 42)
  expect(parsed).toEqual({
    worktreeId: '',
    paneKey: '',
    state: 'working',
    receivedAt: 42
  })
})

test('parseAgentStatusPayload ignores a payload without a state string', () => {
  expect(parseAgentStatusPayload({ receivedAt: 1 }, 2)).toBeNull()
  expect(parseAgentStatusPayload(null, 2)).toBeNull()
  expect(parseAgentStatusPayload('working', 2)).toBeNull()
})

test('parseAgentStatusPayload reads nested Orca-3 agent identity', () => {
  const parsed = parseAgentStatusPayload(
    {
      worktreeId: 'wt',
      paneKey: 'p',
      state: 'working',
      receivedAt: 7,
      agent: { type: 'claude', model: 'opus', profile: 'review' }
    },
    9
  )
  expect(parsed?.agent).toEqual({ type: 'claude', model: 'opus', profile: 'review' })
})

test('two paneKeys stay distinct and summarize with agentCount', () => {
  const { table } = tableHarness()
  table.upsert({
    worktreeId: 'wt',
    paneKey: 'a',
    state: 'working',
    receivedAt: 1_000_000
  })
  table.upsert({
    worktreeId: 'wt',
    paneKey: 'b',
    state: 'waiting',
    receivedAt: 1_000_100
  })
  const summary = table.summarize()
  expect(summary.agentCount).toBe(2)
  expect(summary.agentState).toBe('waiting')
  expect(summary.stateStartedAtMs).toBe(1_000_100)
})

test('aggregate priority is blocked over waiting over working over done', () => {
  const { table } = tableHarness()
  table.upsert({ worktreeId: 'w', paneKey: '1', state: 'done', receivedAt: 1 })
  table.upsert({ worktreeId: 'w', paneKey: '2', state: 'working', receivedAt: 2 })
  expect(table.summarize().agentState).toBe('working')
  table.upsert({ worktreeId: 'w', paneKey: '3', state: 'needs_input', receivedAt: 3 })
  expect(table.summarize().agentState).toBe('waiting')
  table.upsert({ worktreeId: 'w', paneKey: '4', state: 'error', receivedAt: 4 })
  expect(table.summarize().agentState).toBe('blocked')
})

test('an empty table has no agent state', () => {
  const { table } = tableHarness()
  expect(table.summarize()).toEqual({
    agentCount: 0,
    agentState: undefined,
    stateStartedAtMs: undefined,
    agentType: undefined,
    agentModel: undefined,
    agentProfile: undefined
  })
})

test('summarize copies identity from the winning slot', () => {
  const { table } = tableHarness()
  table.upsert({
    worktreeId: 'w',
    paneKey: 'idle',
    state: 'done',
    receivedAt: 1,
    agent: { type: 'other', model: 'small' }
  })
  table.upsert({
    worktreeId: 'w',
    paneKey: 'hot',
    state: 'blocked',
    receivedAt: 2,
    agent: { type: 'claude', model: 'opus', profile: 'review' }
  })
  expect(table.summarize()).toMatchObject({
    agentState: 'blocked',
    agentType: 'claude',
    agentModel: 'opus',
    agentProfile: 'review'
  })
})

test('done agents drop after 60 seconds and refresh the table', async () => {
  const { table, advance, changes } = tableHarness()
  table.upsert({
    worktreeId: 'w',
    paneKey: 'p',
    state: 'complete',
    receivedAt: 1_000_000
  })
  expect(table.summarize().agentCount).toBe(1)
  await advance(AGENT_RETENTION_MS.done - 1)
  expect(table.summarize().agentCount).toBe(1)
  await advance(1)
  expect(table.summarize().agentCount).toBe(0)
  expect(changes.length).toBeGreaterThanOrEqual(1)
})

test('stale non-done agents drop after 30 minutes', async () => {
  const { table, advance } = tableHarness()
  table.upsert({
    worktreeId: 'w',
    paneKey: 'p',
    state: 'working',
    receivedAt: 1_000_000
  })
  await advance(AGENT_RETENTION_MS.stale - 1)
  expect(table.summarize().agentCount).toBe(1)
  await advance(1)
  expect(table.summarize().agentCount).toBe(0)
})

test('removeWorktree drops only matching slots', () => {
  const { table } = tableHarness()
  table.upsert({ worktreeId: 'keep', paneKey: 'a', state: 'working', receivedAt: 1 })
  table.upsert({ worktreeId: 'gone', paneKey: 'a', state: 'working', receivedAt: 1 })
  expect(table.removeWorktree('gone')).toBe(true)
  expect(table.summarize().agentCount).toBe(1)
  expect(table.slots()[0]?.worktreeId).toBe('keep')
})

test('parseWorktreeRemovedId reads worktreeId or id', () => {
  expect(parseWorktreeRemovedId({ worktreeId: 'repo::/x' })).toBe('repo::/x')
  expect(parseWorktreeRemovedId({ id: 'wt-2' })).toBe('wt-2')
  expect(parseWorktreeRemovedId('wt-3')).toBe('wt-3')
  expect(parseWorktreeRemovedId({})).toBeNull()
})

test('paneKeyMatchesAgentId accepts exact or prefix: joins', () => {
  expect(paneKeyMatchesAgentId('sess-1', 'sess-1')).toBe(true)
  expect(paneKeyMatchesAgentId('sess-1:tab', 'sess-1')).toBe(true)
  expect(paneKeyMatchesAgentId('sess-12', 'sess-1')).toBe(false)
  expect(paneKeyMatchesAgentId('other', 'sess-1')).toBe(false)
  expect(paneKeyMatchesAgentId('sess-1', '')).toBe(false)
})

test('summarize keeps global count/state and prefers focused identity', () => {
  const { table } = tableHarness()
  table.upsert({
    worktreeId: 'wt-a',
    paneKey: 'sess-1',
    state: 'working',
    receivedAt: 1,
    agent: { type: 'claude', model: 'opus', profile: 'review' }
  })
  table.upsert({
    worktreeId: 'wt-b',
    paneKey: 'sess-2',
    state: 'blocked',
    receivedAt: 2,
    agent: { type: 'codex', model: 'gpt', profile: 'fast' }
  })
  expect(table.summarize()).toMatchObject({
    agentCount: 2,
    agentState: 'blocked',
    agentType: 'codex',
    agentModel: 'gpt'
  })
  expect(
    table.summarize({ worktreeId: 'wt-a', agentId: 'sess-1' })
  ).toMatchObject({
    agentCount: 2,
    agentState: 'blocked',
    agentType: 'claude',
    agentModel: 'opus',
    agentProfile: 'review'
  })
  expect(table.summarize({ agentId: 'sess-1' })).toMatchObject({
    agentCount: 2,
    agentState: 'blocked',
    agentType: 'claude'
  })
})

test('summarize falls back to the full table when focus matches nothing', () => {
  const { table } = tableHarness()
  table.upsert({
    worktreeId: 'wt',
    paneKey: 'hot',
    state: 'blocked',
    receivedAt: 2,
    agent: { type: 'claude', model: 'opus' }
  })
  expect(table.summarize({ worktreeId: 'missing', agentId: 'nope' })).toMatchObject({
    agentCount: 1,
    agentState: 'blocked',
    agentType: 'claude',
    agentModel: 'opus'
  })
})
