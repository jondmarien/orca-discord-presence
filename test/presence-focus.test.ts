import { expect, test } from 'bun:test'
import { ACTIVITY_EXPIRY_MS } from '../src/presence/expiry'
import {
  FOCUSED_SURFACE_LABELS,
  formatFocusedSurface,
  parseUiFocusChanged
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
