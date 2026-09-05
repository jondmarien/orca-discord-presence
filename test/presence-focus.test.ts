import { expect, test } from 'bun:test'
import { ACTIVITY_EXPIRY_MS } from '../src/presence/expiry'
import {
  FOCUSED_SURFACE_LABELS,
  FOCUS_JOIN_KEY_MAX,
  focusedJoinKeysPresent,
  formatFocusedSurface,
  parseOptionalHostJoinKey,
  parseUiFocusChanged,
  parseUiReadFocus,
  pickFocusedSurface,
  probeUiReadFocus
} from '../src/presence/focus'
import { normalizeSettings } from '../src/presence/settings'

const NOW = 1_700_000_060_000

function settingsWith(overrides: Record<string, unknown>) {
  return normalizeSettings(overrides)
}

test('known focused-surface kinds have short labels', () => {
  expect(FOCUSED_SURFACE_LABELS.terminal).toBe('Terminal')
  expect(FOCUSED_SURFACE_LABELS.agent).toBe('Agent')
  expect(FOCUSED_SURFACE_LABELS['command-palette']).toBe('Command palette')
})

test('parseUiFocusChanged accepts a host payload and rejects junk', () => {
  expect(
    parseUiFocusChanged({
      focusedSurface: { kind: 'editor', title: 'app.ts' },
      receivedAt: 42
    })
  ).toEqual({
    focusedSurface: { kind: 'editor', title: 'app.ts' },
    receivedAt: 42
  })
  expect(parseUiFocusChanged({ focusedSurface: null, receivedAt: 9 })).toEqual({
    focusedSurface: null,
    receivedAt: 9
  })
  expect(parseUiFocusChanged({ focusedSurface: { kind: 'nope', title: 'x' }, receivedAt: 1 })).toBeNull()
  expect(parseUiFocusChanged(null)).toBeNull()
})

test('parseUiFocusChanged feature-detects join keys on the surface only', () => {
  expect(
    parseUiFocusChanged({
      focusedSurface: {
        kind: 'agent',
        title: 'Claude',
        worktreeId: 'repo::/tmp/a',
        agentId: 'sess-1',
        leftover: true
      },
      receivedAt: 7,
      worktreeId: 'envelope-must-be-ignored',
      agentId: 'envelope-must-be-ignored'
    })
  ).toEqual({
    focusedSurface: { kind: 'agent', title: 'Claude', worktreeId: 'repo::/tmp/a', agentId: 'sess-1' },
    receivedAt: 7
  })
})

test('parseUiReadFocus reads { focusedSurface } and rejects a missing key', () => {
  expect(parseUiReadFocus({ focusedSurface: { kind: 'browser', title: 'orca.dev' } })).toEqual({
    focusedSurface: { kind: 'browser', title: 'orca.dev' }
  })
  expect(
    parseUiReadFocus({
      focusedSurface: { kind: 'agent', title: 'Claude', worktreeId: 'wt', agentId: 'ag' }
    })
  ).toEqual({
    focusedSurface: { kind: 'agent', title: 'Claude', worktreeId: 'wt', agentId: 'ag' }
  })
  expect(
    parseUiReadFocus({
      focusedSurface: {
        kind: 'editor',
        title: 'app.ts',
        worktreeId: 'repo-1::/Users/private/orca',
        agentId: 'tab-must-drop',
        leftover: true
      }
    })
  ).toEqual({
    focusedSurface: { kind: 'editor', title: 'app.ts', worktreeId: 'repo-1::/Users/private/orca' }
  })
  expect(
    parseUiReadFocus({
      focusedSurface: { kind: 'terminal', title: 'zsh', worktreeId: null, agentId: null }
    })
  ).toEqual({ focusedSurface: { kind: 'terminal', title: 'zsh' } })
  expect(parseUiReadFocus({ focusedSurface: null })).toEqual({ focusedSurface: null })
  expect(parseUiReadFocus({ focusedSurface: { kind: 'nope', title: 'x' } })).toBeUndefined()
  expect(parseUiReadFocus({})).toBeUndefined()
  expect(parseUiReadFocus(null)).toBeUndefined()
})

test('parseOptionalHostJoinKey drops empty and over-length keys', () => {
  expect(parseOptionalHostJoinKey('  wt  ')).toBe('wt')
  expect(parseOptionalHostJoinKey('')).toBeUndefined()
  expect(parseOptionalHostJoinKey(null)).toBeUndefined()
  expect(parseOptionalHostJoinKey('x'.repeat(FOCUS_JOIN_KEY_MAX + 1))).toBeUndefined()
})

test('host #8 join keys never enter Discord focus copy', () => {
  const parsed = parseUiReadFocus({
    focusedSurface: {
      kind: 'agent',
      title: 'Claude',
      worktreeId: 'repo-1::/Users/private/orca',
      agentId: 'tab-agent-1'
    }
  })
  const formatted = formatFocusedSurface(
    {
      focusedSurfaceKind: parsed?.focusedSurface?.kind,
      focusedSurfaceTitle: parsed?.focusedSurface?.title,
      focusedSurfaceAtMs: NOW
    },
    settingsWith({
      showFocusedSurface: true,
      focusedSurfaceDetail: 'kind+title',
      detailLevel: 'full'
    }),
    NOW
  )
  expect(formatted).toBe('Agent · Claude')
  expect(formatted?.includes('/Users/private')).toBe(false)
  expect(formatted?.includes('tab-agent-1')).toBe(false)
  expect(formatted?.includes('repo-1')).toBe(false)
})

test('formatFocusedSurface never includes join keys', () => {
  const formatted = formatFocusedSurface(
    {
      focusedSurfaceKind: 'editor',
      focusedSurfaceTitle: 'app.ts',
      focusedSurfaceAtMs: NOW
    },
    settingsWith({
      showFocusedSurface: true,
      focusedSurfaceDetail: 'kind+title',
      detailLevel: 'full'
    }),
    NOW
  )
  expect(formatted).toBe('Editor · app.ts')
  expect(formatted?.includes('worktree')).toBe(false)
  expect(formatted?.includes('agentId')).toBe(false)
})

test('pickFocusedSurface prefers readContext, then ui.readFocus, then the event', () => {
  const nowMs = 99
  expect(
    pickFocusedSurface({
      context: { focusedSurfacePresent: true, focusedSurface: { kind: 'terminal', title: 'zsh' } },
      readFocus: { focusedSurface: { kind: 'editor', title: 'app.ts' } },
      lastEvent: { focusedSurface: { kind: 'browser', title: 'x' }, receivedAt: 1 },
      nowMs
    })
  ).toEqual({
    surface: { kind: 'terminal', title: 'zsh' },
    atMs: nowMs,
    source: 'readContext'
  })
  expect(
    pickFocusedSurface({
      context: { focusedSurfacePresent: false },
      readFocus: { focusedSurface: { kind: 'agent', title: 'Claude', agentId: 'a1' } },
      lastEvent: { focusedSurface: { kind: 'browser', title: 'x' }, receivedAt: 1 },
      nowMs
    })
  ).toEqual({
    surface: { kind: 'agent', title: 'Claude', agentId: 'a1' },
    atMs: nowMs,
    source: 'readFocus'
  })
  expect(
    pickFocusedSurface({
      context: null,
      lastEvent: { focusedSurface: null, receivedAt: 5 },
      nowMs
    })
  ).toEqual({ surface: null, atMs: undefined, source: 'event' })
  expect(focusedJoinKeysPresent({ kind: 'agent', title: null, worktreeId: 'wt' })).toBe(true)
  expect(focusedJoinKeysPresent({ kind: 'agent', title: null })).toBe(false)
})

test('probeUiReadFocus caches a method miss', async () => {
  const cache = { missing: false }
  let calls = 0
  const missing = async () => {
    calls += 1
    throw new Error('unknown method')
  }
  expect(await probeUiReadFocus(missing, cache)).toBeUndefined()
  expect(cache.missing).toBe(true)
  expect(await probeUiReadFocus(missing, cache)).toBeUndefined()
  expect(calls).toBe(1)
  expect(
    await probeUiReadFocus(async () => ({ focusedSurface: { kind: 'editor', title: 'app.ts' } }), {
      missing: false
    })
  ).toEqual({ focusedSurface: { kind: 'editor', title: 'app.ts' } })
})

test('formatFocusedSurface is omitted when the toggle is off or detail is generic', () => {
  const snapshot = {
    focusedSurfaceKind: 'terminal',
    focusedSurfaceTitle: 'zsh',
    focusedSurfaceAtMs: NOW
  }
  expect(formatFocusedSurface(snapshot, settingsWith({ showFocusedSurface: false }), NOW)).toBeNull()
  expect(
    formatFocusedSurface(
      snapshot,
      settingsWith({ showFocusedSurface: true, detailLevel: 'generic' }),
      NOW
    )
  ).toBeNull()
})

test('formatFocusedSurface at workspace is kind-only even when title detail is on', () => {
  expect(
    formatFocusedSurface(
      {
        focusedSurfaceKind: 'terminal',
        focusedSurfaceTitle: 'secret.ts',
        focusedSurfaceAtMs: NOW
      },
      settingsWith({
        showFocusedSurface: true,
        focusedSurfaceDetail: 'kind+title',
        detailLevel: 'workspace'
      }),
      NOW
    )
  ).toBe('Terminal')
})

test('formatFocusedSurface at full can include a host-truncated title', () => {
  expect(
    formatFocusedSurface(
      {
        focusedSurfaceKind: 'editor',
        focusedSurfaceTitle: 'app.ts',
        focusedSurfaceAtMs: NOW
      },
      settingsWith({
        showFocusedSurface: true,
        focusedSurfaceDetail: 'kind+title',
        detailLevel: 'full'
      }),
      NOW
    )
  ).toBe('Editor · app.ts')
})

test('formatFocusedSurface drops an unknown kind and a stale sample', () => {
  expect(
    formatFocusedSurface(
      {
        focusedSurfaceKind: 'exfil',
        focusedSurfaceTitle: 'nope',
        focusedSurfaceAtMs: NOW
      },
      settingsWith({ showFocusedSurface: true, detailLevel: 'full' }),
      NOW
    )
  ).toBeNull()
  expect(
    formatFocusedSurface(
      {
        focusedSurfaceKind: 'terminal',
        focusedSurfaceTitle: 'zsh',
        focusedSurfaceAtMs: NOW - ACTIVITY_EXPIRY_MS.long
      },
      settingsWith({ showFocusedSurface: true, detailLevel: 'workspace' }),
      NOW
    )
  ).toBeNull()
})
