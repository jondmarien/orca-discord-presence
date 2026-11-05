import { expect, test } from 'bun:test'
import { AGENT_RETENTION_MS } from '../src/presence/expiry'
import {
  agentSlotKey,
  createAgentTable,
  parseAgentsList,
  parseAgentStatusPayload,
  parseWorkspaceRemovedId
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

test('parseAgentStatusPayload reads workspaceId, paneKey, state, and receivedAt', () => {
  const parsed = parseAgentStatusPayload(
    {
      workspaceId: 'repo::/tmp/a',
      paneKey: 'tab:one',
      state: 'running',
      receivedAt: 1_700_000_000_000
    },
    9
  )
  expect(parsed).toEqual({
    workspaceId: 'repo::/tmp/a',
    paneKey: 'tab:one',
    state: 'running',
    receivedAt: 1_700_000_000_000
  })
})

test('parseAgentStatusPayload fills missing ids and receivedAt', () => {
  const parsed = parseAgentStatusPayload({ state: 'working' }, 42)
  expect(parsed).toEqual({
    workspaceId: '',
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

test('two paneKeys stay distinct and summarize with agentCount', () => {
  const { table } = tableHarness()
  table.upsert({
    workspaceId: 'wt',
    paneKey: 'a',
    state: 'working',
    receivedAt: 1_000_000
  })
  table.upsert({
    workspaceId: 'wt',
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
  table.upsert({ workspaceId: 'w', paneKey: '1', state: 'done', receivedAt: 1 })
  table.upsert({ workspaceId: 'w', paneKey: '2', state: 'working', receivedAt: 2 })
  expect(table.summarize().agentState).toBe('working')
  table.upsert({ workspaceId: 'w', paneKey: '3', state: 'needs_input', receivedAt: 3 })
  expect(table.summarize().agentState).toBe('waiting')
  table.upsert({ workspaceId: 'w', paneKey: '4', state: 'error', receivedAt: 4 })
  expect(table.summarize().agentState).toBe('blocked')
})

test('one done agent summarizes as done, which the panel shows as completed', () => {
  const { table } = tableHarness()
  table.upsert({ workspaceId: 'w', paneKey: '1', state: 'done', receivedAt: 1_000_000 })
  expect(table.summarize().agentState).toBe('done')
  expect(table.summarize().agentCount).toBe(1)
})

test('an idle agent summarizes as idle, below done', () => {
  const { table } = tableHarness()
  table.upsert({ workspaceId: 'w', paneKey: '1', state: 'idle', receivedAt: 1_000_000 })
  expect(table.summarize().agentState).toBe('idle')
  table.upsert({ workspaceId: 'w', paneKey: '2', state: 'done', receivedAt: 1_000_000 })
  expect(table.summarize().agentState).toBe('done')
})

test('an empty table has no agent state', () => {
  const { table } = tableHarness()
  expect(table.summarize()).toEqual({
    agentCount: 0,
    agentState: undefined,
    stateStartedAtMs: undefined
  })
})

test('done agents drop after 60 seconds and refresh the table', async () => {
  const { table, advance, changes } = tableHarness()
  table.upsert({
    workspaceId: 'w',
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
    workspaceId: 'w',
    paneKey: 'p',
    state: 'working',
    receivedAt: 1_000_000
  })
  await advance(AGENT_RETENTION_MS.stale - 1)
  expect(table.summarize().agentCount).toBe(1)
  await advance(1)
  expect(table.summarize().agentCount).toBe(0)
})

test('removeWorkspace drops only matching slots', () => {
  const { table } = tableHarness()
  table.upsert({ workspaceId: 'keep', paneKey: 'a', state: 'working', receivedAt: 1 })
  table.upsert({ workspaceId: 'gone', paneKey: 'a', state: 'working', receivedAt: 1 })
  expect(table.removeWorkspace('gone')).toBe(true)
  expect(table.summarize().agentCount).toBe(1)
  expect(table.slots()[0]?.workspaceId).toBe('keep')
})

test('parseWorkspaceRemovedId reads workspaceId', () => {
  expect(parseWorkspaceRemovedId({ workspaceId: 'w1', kind: 'git', path: '/x' })).toBe('w1')
  expect(parseWorkspaceRemovedId({ workspaceId: '  ' })).toBeNull()
  expect(parseWorkspaceRemovedId({})).toBeNull()
  expect(parseWorkspaceRemovedId(null)).toBeNull()
})

test('agentSlotKey prefers terminalId, else workspace + pane', () => {
  expect(agentSlotKey({ workspaceId: 'w', paneKey: 'p', terminalId: 't1' })).toBe('t:t1')
  expect(agentSlotKey({ workspaceId: 'w', paneKey: 'p' })).toBe('p:w\u001fp')
  expect(agentSlotKey({ workspaceId: 'w', paneKey: 'p', terminalId: '' })).toBe('p:w\u001fp')
})

test('parseAgentStatusPayload reads terminalId and null workspaceId', () => {
  expect(
    parseAgentStatusPayload(
      { workspaceId: null, paneKey: 'k', terminalId: 't9', state: 'working', receivedAt: 5 },
      1
    )
  ).toEqual({ workspaceId: '', paneKey: 'k', terminalId: 't9', state: 'working', receivedAt: 5 })
})

test('parseAgentsList maps rows and drops null terminalId', () => {
  expect(
    parseAgentsList(
      {
        agents: [
          { terminalId: 't1', title: null, agent: 'claude', state: 'working', stateStartedAt: 7 },
          { terminalId: null, title: null, agent: null, state: 'idle', stateStartedAt: 8 },
          { terminalId: 't2', title: 'x', agent: 'codex', state: 'done' }
        ]
      },
      10
    )
  ).toEqual([
    { workspaceId: '', paneKey: '', terminalId: 't1', state: 'working', receivedAt: 7, kind: 'claude' },
    { workspaceId: '', paneKey: '', terminalId: 't2', state: 'done', receivedAt: 10, kind: 'codex' }
  ])
})

test('parseAgentsList tolerates junk', () => {
  expect(parseAgentsList(null, 1)).toEqual([])
  expect(parseAgentsList({}, 1)).toEqual([])
  expect(parseAgentsList({ agents: 'x' }, 1)).toEqual([])
})

test('seeded agent then event for same terminalId counts once', () => {
  const { table } = tableHarness()
  for (const event of parseAgentsList(
    { agents: [{ terminalId: 't1', title: null, agent: 'claude', state: 'working', stateStartedAt: 1 }] },
    10
  )) {
    table.upsert(event)
  }
  table.upsert({
    workspaceId: 'w1',
    paneKey: 'tab:leaf',
    terminalId: 't1',
    state: 'blocked',
    receivedAt: 20
  })
  const summary = table.summarize()
  expect(summary.agentCount).toBe(1)
  expect(summary.agentState).toBe('blocked')
  expect(table.removeWorkspace('w1')).toBe(true)
})

test('agent kind survives a later event without kind', () => {
  const { table } = tableHarness()
  const [seeded] = parseAgentsList({ agents: [{ terminalId: 't1', state: 'working', agent: 'claude' }] }, 1)
  expect(seeded?.kind).toBe('claude')
  expect(parseAgentsList({ agents: [{ terminalId: 't2', state: 'working', agent: '' }] }, 1)[0]).not.toHaveProperty('kind')
  table.upsert(seeded!)
  table.upsert({ workspaceId: 'w', paneKey: 'p', terminalId: 't1', state: 'waiting', receivedAt: 1_000_000 })
  expect(table.slots()[0]?.kind).toBe('claude')
  expect(table.slots()[0]?.canonicalState).toBe('waiting')
})
