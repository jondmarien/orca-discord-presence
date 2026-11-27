import { expect, test } from 'bun:test'
import { createAgentTable } from '../src/presence/agents'
import { DEFAULT_SETTINGS } from '../src/presence/settings'
import { createDisposer, type OrcaHost } from '../src/worker/host'
import { createHostSync } from '../src/worker/host-sync'

test('host-sync deduplicates in-flight agent.listSessions, gates when disabled, and evicts stale kind caches', async () => {
  let clock = 10_000
  let sessionCalls = 0
  let releaseSessions!: () => void
  let listCalls = 0

  const agentTable = createAgentTable({ now: () => clock })
  const disposer = createDisposer()

  const host: OrcaHost['host'] = {
    has: (method) => ['workspace.list', 'agents.list', 'agent.listSessions'].includes(method),
    call: async (method) => {
      if (method === 'agent.listSessions') {
        sessionCalls += 1
        await new Promise<void>((resolve) => {
          releaseSessions = resolve
        })
        return {
          sessions: [
            {
              sessionId: 's1',
              workspaceId: 'w1',
              title: 'SECRET',
              messageCount: 10,
              totalTokens: 5000,
              updatedAt: clock,
              running: true
            }
          ]
        }
      }
      if (method === 'agents.list') {
        listCalls += 1
        return {
          agents: [
            {
              terminalId: 't1',
              agent: 'claude',
              state: 'working',
              stateStartedAt: clock
            }
          ]
        }
      }
      return null
    }
  }

  const sync = createHostSync({ host, agentTable, disposer, now: () => clock })

  // 1. Both session stats & leaderboards disabled -> never calls agent.listSessions.
  await sync.syncSessionsIfNeeded(DEFAULT_SETTINGS, true)
  expect(sessionCalls).toBe(0)

  // 2. Concurrent calls while enabled share a single in-flight request.
  const enabledSettings = { ...DEFAULT_SETTINGS, showLeaderboards: true }
  const p1 = sync.syncSessionsIfNeeded(enabledSettings, true)
  const p2 = sync.syncSessionsIfNeeded(enabledSettings, true)
  releaseSessions()
  await Promise.all([p1, p2])
  expect(sessionCalls).toBe(1)
  expect(sync.sessions()).toHaveLength(1)

  // 3. Kind lookup caches known terminal, then evicts it once workspace is removed so a later run retries.
  await sync.ensureAgentKind('t1', 'w1')
  expect(listCalls).toBe(1)
  await sync.ensureAgentKind('t1', 'w1')
  expect(listCalls).toBe(1)

  agentTable.removeWorkspace('w1')
  sync.removeWorkspaces(['w1'])
  await sync.ensureAgentKind('t1', 'w1')
  expect(listCalls).toBe(2)

  sync.clear()
  agentTable.clear()
  disposer.disposeAll()
})

test('focused workspace metadata revalidates after the throttle on forced refresh', async () => {
  let clock = 10_000
  let workspaceName = 'Alpha'
  let calls = 0
  const disposer = createDisposer()
  const agentTable = createAgentTable({ now: () => clock })
  const host: OrcaHost['host'] = {
    has: (method) => method === 'workspace.list',
    call: async () => {
      calls += 1
      return { workspaces: [{ id: 'w1', name: workspaceName, project: workspaceName, hostId: 'local' }] }
    }
  }
  const sync = createHostSync({ host, agentTable, disposer, now: () => clock })
  expect((await sync.resolveFocusedWorkspace('w1'))?.project).toBe('Alpha')
  workspaceName = 'Beta'
  clock += 5_001
  expect((await sync.resolveFocusedWorkspace('w1', true))?.project).toBe('Beta')
  expect(sync.workspaces().get('w1')?.name).toBe('Beta')
  await sync.resolveFocusedWorkspace('w1', true)
  expect(calls).toBe(2)
  disposer.disposeAll()
})
