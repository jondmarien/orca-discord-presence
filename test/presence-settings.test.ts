import { expect, test } from 'bun:test'
import {
  DEFAULT_OPEN_BUTTON_LABEL,
  DEFAULT_SETTINGS,
  DETAIL_LEVELS,
  SHIPPED_APPLICATION_ID,
  normalizeOpenButtonLabel,
  normalizeOpenUrl,
  normalizeSettings,
  nextDetailLevel,
  toggleField
} from '../src/presence/settings'

test('defaults are privacy-preserving', () => {
  expect(DEFAULT_SETTINGS.enabled).toBe(true)
  expect(DEFAULT_SETTINGS.detailLevel).toBe('generic')
  expect(DEFAULT_SETTINGS.showBranch).toBe(false)
  expect(DEFAULT_SETTINGS.showMachine).toBe(false)
  expect(DEFAULT_SETTINGS.showTerminals).toBe(false)
  expect(DEFAULT_SETTINGS.showAgentState).toBe(true)
  expect(DEFAULT_SETTINGS.showElapsed).toBe(true)
  expect(DEFAULT_SETTINGS.bridgeEnabled).toBe(false)
  expect(DEFAULT_SETTINGS.bridgeUrl).toBe('')
  expect(DEFAULT_SETTINGS.bridgeToken).toBe('')
  expect(DEFAULT_SETTINGS.debugLogging).toBe(true)
  expect(DEFAULT_SETTINGS.openUrl).toBe('')
  expect(DEFAULT_SETTINGS.showOpenButton).toBe(false)
  expect(DEFAULT_SETTINGS.openButtonLabel).toBe(DEFAULT_OPEN_BUTTON_LABEL)
  expect(DEFAULT_SETTINGS.showAgentCount).toBe(false)
})

test('normalize fills gaps and drops unknown keys', () => {
  const settings = normalizeSettings({ showBranch: true, nonsense: 42 })
  expect(settings.showBranch).toBe(true)
  expect(settings.detailLevel).toBe('generic')
  expect('nonsense' in settings).toBe(false)
})

test('normalize rejects a non-boolean toggle and falls back to the default', () => {
  expect(normalizeSettings({ showBranch: 'yes' }).showBranch).toBe(false)
})

test('normalize rejects an unknown detail level', () => {
  expect(normalizeSettings({ detailLevel: 'everything' }).detailLevel).toBe('generic')
})

test('the plugin ships the Discord application id', () => {
  expect(DEFAULT_SETTINGS.applicationId).toBe('1545653843239374848')
  expect(SHIPPED_APPLICATION_ID).toBe('1545653843239374848')
})

test('an absent application id falls back to the shipped default', () => {
  expect(normalizeSettings({}).applicationId).toBe(DEFAULT_SETTINGS.applicationId)
})

test('normalize accepts a plausible application id override and rejects junk', () => {
  expect(normalizeSettings({ applicationId: '123456789012345678' }).applicationId).toBe(
    '123456789012345678'
  )
  expect(normalizeSettings({ applicationId: 'not-a-snowflake' }).applicationId).toBe(
    DEFAULT_SETTINGS.applicationId
  )
})

test('detail level cycles in a fixed order and wraps', () => {
  expect([...DETAIL_LEVELS]).toEqual(['off', 'generic', 'workspace', 'full'])
  expect(nextDetailLevel('generic')).toBe('workspace')
  expect(nextDetailLevel('full')).toBe('off')
})

test('toggleField flips exactly one boolean', () => {
  const next = toggleField({ ...DEFAULT_SETTINGS }, 'showBranch')
  expect(next.showBranch).toBe(true)
  expect(next.showMachine).toBe(DEFAULT_SETTINGS.showMachine)
  expect(next).not.toBe(DEFAULT_SETTINGS)
})

test('toggleField ignores a non-boolean field name', () => {
  expect(toggleField({ ...DEFAULT_SETTINGS }, 'detailLevel')).toEqual({ ...DEFAULT_SETTINGS })
})

test('normalize accepts a loopback bridge url and trims the token', () => {
  const settings = normalizeSettings({
    bridgeEnabled: true,
    bridgeUrl: 'http://127.0.0.1:3848/activity',
    bridgeToken: '  secret  '
  })
  expect(settings.bridgeEnabled).toBe(true)
  expect(settings.bridgeUrl).toBe('http://127.0.0.1:3848')
  expect(settings.bridgeToken).toBe('secret')
})

test('normalize rejects non-http bridge urls and credentials-in-url', () => {
  expect(normalizeSettings({ bridgeUrl: 'javascript:alert(1)' }).bridgeUrl).toBe('')
  expect(normalizeSettings({ bridgeUrl: 'http://user:pass@127.0.0.1:3848' }).bridgeUrl).toBe('')
  expect(normalizeSettings({ bridgeUrl: 'not a url' }).bridgeUrl).toBe('')
})

test('toggleField flips bridgeEnabled', () => {
  const next = toggleField({ ...DEFAULT_SETTINGS }, 'bridgeEnabled')
  expect(next.bridgeEnabled).toBe(true)
})

test('toggleField flips debugLogging', () => {
  expect(toggleField({ ...DEFAULT_SETTINGS }, 'debugLogging').debugLogging).toBe(false)
})

test('toggleField flips showOpenButton and showAgentCount', () => {
  expect(toggleField({ ...DEFAULT_SETTINGS }, 'showOpenButton').showOpenButton).toBe(true)
  expect(toggleField({ ...DEFAULT_SETTINGS }, 'showAgentCount').showAgentCount).toBe(true)
})

test('normalizeOpenUrl keeps https and rejects everything else', () => {
  expect(normalizeOpenUrl('https://orca.example/docs')).toBe('https://orca.example/docs')
  expect(normalizeOpenUrl('  https://orca.example/docs  ')).toBe('https://orca.example/docs')
  expect(normalizeOpenUrl('http://orca.example/docs')).toBe('')
  expect(normalizeOpenUrl('javascript:alert(1)')).toBe('')
  expect(normalizeOpenUrl('https://user:pass@orca.example/docs')).toBe('')
  expect(normalizeOpenUrl('not a url')).toBe('')
  expect(normalizeOpenUrl('')).toBe('')
})

test('normalizeOpenButtonLabel defaults and clamps to 32 characters', () => {
  expect(normalizeOpenButtonLabel('')).toBe(DEFAULT_OPEN_BUTTON_LABEL)
  expect(normalizeOpenButtonLabel(' Docs ')).toBe('Docs')
  expect(normalizeOpenButtonLabel('x'.repeat(40))).toBe('x'.repeat(32))
})

test('normalizeSettings accepts openUrl and drops an invalid one', () => {
  expect(normalizeSettings({ openUrl: 'https://example.com/x', showOpenButton: true }).openUrl).toBe(
    'https://example.com/x'
  )
  expect(normalizeSettings({ openUrl: 'http://example.com' }).openUrl).toBe('')
})
