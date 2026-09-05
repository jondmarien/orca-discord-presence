import { expect, test } from 'bun:test'
import {
  parseAgentIdentity,
  parseWorkspaceContext,
  resolveMachineName
} from '../src/presence/host-context'

test('parseWorkspaceContext returns null for a missing payload', () => {
  expect(parseWorkspaceContext(null)).toBeNull()
  expect(parseWorkspaceContext(undefined)).toBeNull()
  expect(parseWorkspaceContext('nope')).toBeNull()
})

test('parseWorkspaceContext reads stock fields and ignores unknown extras', () => {
  const parsed = parseWorkspaceContext({
    displayName: 'acme',
    branch: 'main',
    terminals: [{ id: 't1' }, { id: 't2' }],
    leftover: true
  })
  expect(parsed).toEqual({
    displayName: 'acme',
    branch: 'main',
    terminalCount: 2,
    executionHostKind: undefined,
    executionHostLabel: undefined,
    agentType: undefined,
    agentModel: undefined,
    agentProfile: undefined,
    focusedSurface: undefined,
    focusedSurfacePresent: false
  })
})

test('parseWorkspaceContext accepts additive Orca-3 / Orca-4 fields', () => {
  const parsed = parseWorkspaceContext({
    displayName: 'acme',
    branch: 'feat',
    terminals: [],
    executionHost: { kind: 'ssh', label: 'omarchy-box' },
    agent: { type: 'claude', model: 'opus', profile: 'review' },
    focusedSurface: { kind: 'terminal', title: 'zsh' }
  })
  expect(parsed?.executionHostKind).toBe('ssh')
  expect(parsed?.executionHostLabel).toBe('omarchy-box')
  expect(parsed?.agentType).toBe('claude')
  expect(parsed?.agentModel).toBe('opus')
  expect(parsed?.agentProfile).toBe('review')
  expect(parsed?.focusedSurface).toEqual({ kind: 'terminal', title: 'zsh' })
  expect(parsed?.focusedSurfacePresent).toBe(true)
})

test('parseWorkspaceContext feature-detects focusedSurface join keys', () => {
  const parsed = parseWorkspaceContext({
    displayName: 'acme',
    branch: 'feat',
    terminals: [],
    focusedSurface: {
      kind: 'agent',
      title: 'Claude',
      worktreeId: 'repo::/tmp/a',
      agentId: 'sess-1',
      leftover: true
    }
  })
  expect(parsed?.focusedSurface).toEqual({
    kind: 'agent',
    title: 'Claude',
    worktreeId: 'repo::/tmp/a',
    agentId: 'sess-1'
  })
  expect(parsed?.focusedSurfacePresent).toBe(true)
})

test('parseWorkspaceContext treats an explicit null focusedSurface as present', () => {
  const parsed = parseWorkspaceContext({
    displayName: 'acme',
    branch: '',
    terminals: [],
    focusedSurface: null
  })
  expect(parsed?.focusedSurfacePresent).toBe(true)
  expect(parsed?.focusedSurface).toBeNull()
})

test('parseWorkspaceContext drops an unknown executionHost kind and unknown focus kind', () => {
  const parsed = parseWorkspaceContext({
    displayName: 'acme',
    branch: '',
    terminals: [],
    executionHost: { kind: 'quantum', label: 'lab' },
    focusedSurface: { kind: 'exfil', title: '/etc/passwd' }
  })
  expect(parsed?.executionHostKind).toBeUndefined()
  expect(parsed?.executionHostLabel).toBeUndefined()
  expect(parsed?.focusedSurface).toBeUndefined()
  expect(parsed?.focusedSurfacePresent).toBe(true)
})

test('parseAgentIdentity reads the nested agent object and ignores junk', () => {
  expect(parseAgentIdentity({ agent: { type: 'codex', model: 'gpt', profile: 'fast' } })).toEqual({
    type: 'codex',
    model: 'gpt',
    profile: 'fast'
  })
  expect(parseAgentIdentity({ agent: { type: 1, model: '', profile: 'x'.repeat(200) } })).toEqual({
    type: undefined,
    model: undefined,
    profile: undefined
  })
  expect(parseAgentIdentity(null)).toEqual({ type: undefined, model: undefined, profile: undefined })
})

test('resolveMachineName prefers machineLabel, then execution host, then hostname', () => {
  expect(
    resolveMachineName({
      machineLabel: 'work-laptop',
      executionHostLabel: 'ssh-box',
      hostname: 'jon-desktop'
    })
  ).toBe('work-laptop')
  expect(
    resolveMachineName({
      machineLabel: null,
      executionHostLabel: 'ssh-box',
      hostname: 'jon-desktop'
    })
  ).toBe('ssh-box')
  expect(resolveMachineName({ machineLabel: null, hostname: 'jon-desktop' })).toBe('jon-desktop')
})
