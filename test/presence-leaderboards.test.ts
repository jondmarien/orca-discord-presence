import { expect, test } from 'bun:test'
import {
  buildWorkspaceLeaderboard,
  classifyHostKind,
  formatCompactCount,
  parseSessionsList,
  parseWorkspaceList,
  resolveActiveSessionStats
} from '../src/presence/leaderboards'

test('classifyHostKind maps hostId without exposing connection names', () => {
  expect(classifyHostKind(null)).toBe('local')
  expect(classifyHostKind(undefined)).toBe('local')
  expect(classifyHostKind('local')).toBe('local')
  expect(classifyHostKind('ssh:prod-bastion.corp')).toBe('ssh')
  expect(classifyHostKind('runtime:wsl-ubuntu')).toBe('wsl')
})

test('parseWorkspaceList keeps metadata and strips path completely', () => {
  const rows = parseWorkspaceList({
    workspaces: [
      {
        id: 'ws-1',
        kind: 'worktree',
        name: 'feat-v12',
        project: 'orca-discord-presence',
        path: '/home/secret/private/repo',
        branch: 'feat/v12',
        hostId: 'ssh:secret-host.internal',
        status: { state: 'working', unread: false, terminalCount: 2, lastActivityAt: 100 }
      },
      { id: '', name: 'bad', path: '/nope', hostId: null }
    ]
  })
  expect(rows).toEqual([
    {
      id: 'ws-1',
      name: 'feat-v12',
      project: 'orca-discord-presence',
      hostId: 'ssh:secret-host.internal',
      hostKind: 'ssh',
      statusState: 'working',
      terminalCount: 2
    }
  ])
  expect(JSON.stringify(rows)).not.toContain('/home/secret')
})

test('parseSessionsList discards session.title immediately', () => {
  const parsed = parseSessionsList({
    sessions: [
      {
        sessionId: 's1',
        agent: 'claude',
        title: 'SUPER SECRET FIRST PROMPT',
        workspaceId: 'ws-1',
        hostId: 'local',
        branch: 'secret-branch',
        createdAt: 10,
        updatedAt: 20,
        messageCount: 38,
        totalTokens: 142_300,
        running: true
      }
    ]
  })
  expect(parsed).toEqual([
    {
      sessionId: 's1',
      workspaceId: 'ws-1',
      messageCount: 38,
      totalTokens: 142_300,
      updatedAt: 20,
      running: true
    }
  ])
  expect(JSON.stringify(parsed)).not.toContain('SUPER SECRET')
  expect(JSON.stringify(parsed)).not.toContain('secret-branch')
})

test('formatCompactCount formats counts compactly', () => {
  expect(formatCompactCount(0)).toBe('0')
  expect(formatCompactCount(950)).toBe('950')
  expect(formatCompactCount(1_240)).toBe('1.2k')
  expect(formatCompactCount(9_960)).toBe('10k')
  expect(formatCompactCount(142_300)).toBe('142k')
  expect(formatCompactCount(1_450_000)).toBe('1.5M')
})

test('resolveActiveSessionStats sums active/running sessions, prefers focused workspace, and never lets a 0-token session hide tokens', () => {
  const sessions = [
    { sessionId: 's-bg', workspaceId: 'ws-bg', messageCount: 10, totalTokens: 50_000, updatedAt: 10, running: true },
    { sessionId: 's-fg', workspaceId: 'ws-fg', messageCount: 38, totalTokens: 142_000, updatedAt: 20, running: true },
    { sessionId: 's-zero', workspaceId: 'ws-fg', messageCount: 0, totalTokens: 0, updatedAt: 30, running: false }
  ]
  const slots = [
    { workspaceId: '', workspaceListId: 'ws-bg', paneKey: '1', sessionId: 's-bg', rawState: 'blocked', canonicalState: 'blocked' as const, receivedAt: 100 },
    { workspaceId: '', workspaceListId: 'ws-fg', paneKey: '2', sessionId: 's-fg', rawState: 'working', canonicalState: 'working' as const, receivedAt: 90 }
  ]
  // Focused workspace has both tokens & messages -> uses focused workspace totals.
  expect(resolveActiveSessionStats(slots, sessions, 'ws-fg')).toEqual({ tokens: 142_000, messages: 38 })
  // Unfocused workspace -> sums all running/matched sessions across Orca.
  expect(resolveActiveSessionStats(slots, sessions, 'ws-other')).toEqual({ tokens: 192_000, messages: 48 })

  // Focused session has messages (14) but 0 tokens while another running session has tokens -> combines cleanly!
  const mixed = [
    { sessionId: 's-opencode', workspaceId: 'ws-fg', messageCount: 14, totalTokens: 0, updatedAt: 40, running: true },
    { sessionId: 's-claude', workspaceId: 'ws-bg', messageCount: 6, totalTokens: 84_000, updatedAt: 50, running: true }
  ]
  expect(resolveActiveSessionStats([], mixed, 'ws-fg')).toEqual({ tokens: 84_000, messages: 14 })

  // Zero totals return undefined.
  expect(
    resolveActiveSessionStats(
      [{ workspaceId: '', paneKey: '1', sessionId: 's-zero', rawState: 'working', canonicalState: 'working', receivedAt: 1 }],
      [{ sessionId: 's-zero', workspaceId: 'ws-fg', messageCount: 0, totalTokens: 0, updatedAt: 30, running: false }]
    )
  ).toBeUndefined()
})

test('buildWorkspaceLeaderboard aggregates known workspaces, ignores unknown ids, and preserves both top metrics', () => {
  const workspaces = new Map([
    ['ws-1', { name: 'orca-discord-presence' }],
    ['ws-2', { name: 'orca-core' }],
    ['ws-3', { name: 'small-chatty' }]
  ])
  const sessions = [
    { sessionId: 'a', workspaceId: 'ws-1', messageCount: 10, totalTokens: 100_000, updatedAt: 1, running: false },
    { sessionId: 'b', workspaceId: 'ws-1', messageCount: 15, totalTokens: 50_000, updatedAt: 2, running: true },
    { sessionId: 'c', workspaceId: 'ws-2', messageCount: 5, totalTokens: 300_000, updatedAt: 3, running: false },
    { sessionId: 'd', workspaceId: 'ws-3', messageCount: 200, totalTokens: 10_000, updatedAt: 4, running: false },
    { sessionId: 'e', workspaceId: 'unknown::/secret/path', messageCount: 999, totalTokens: 999_999, updatedAt: 5, running: false },
    { sessionId: 'f', workspaceId: null, messageCount: 50, totalTokens: 50_000, updatedAt: 6, running: false }
  ]
  const rows = buildWorkspaceLeaderboard(sessions, workspaces)
  expect(rows).toEqual([
    { name: 'orca-core', messages: 5, tokens: 300_000 },
    { name: 'orca-discord-presence', messages: 25, tokens: 150_000 },
    { name: 'small-chatty', messages: 200, tokens: 10_000 }
  ])
  expect(JSON.stringify(rows)).not.toContain('/secret/path')
})
