import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  DETAIL_LEVELS,
  SHIPPED_APPLICATION_ID,
  normalizeSettings,
  nextDetailLevel,
  toggleField
} from '../src/presence-settings.mjs'

test('defaults are privacy-preserving', () => {
  assert.equal(DEFAULT_SETTINGS.enabled, true)
  assert.equal(DEFAULT_SETTINGS.detailLevel, 'generic')
  assert.equal(DEFAULT_SETTINGS.showBranch, false)
  assert.equal(DEFAULT_SETTINGS.showMachine, false)
  assert.equal(DEFAULT_SETTINGS.showTerminals, false)
  assert.equal(DEFAULT_SETTINGS.showAgentState, true)
  assert.equal(DEFAULT_SETTINGS.showElapsed, true)
})

test('normalize fills gaps and drops unknown keys', () => {
  const settings = normalizeSettings({ showBranch: true, nonsense: 42 })
  assert.equal(settings.showBranch, true)
  assert.equal(settings.detailLevel, 'generic')
  assert.equal('nonsense' in settings, false)
})

test('normalize rejects a non-boolean toggle and falls back to the default', () => {
  assert.equal(normalizeSettings({ showBranch: 'yes' }).showBranch, false)
})

test('normalize rejects an unknown detail level', () => {
  assert.equal(normalizeSettings({ detailLevel: 'everything' }).detailLevel, 'generic')
})

test('the plugin ships the Discord application id', () => {
  assert.equal(DEFAULT_SETTINGS.applicationId, '1545653843239374848')
  assert.equal(SHIPPED_APPLICATION_ID, '1545653843239374848')
})

test('an absent application id falls back to the shipped default', () => {
  assert.equal(normalizeSettings({}).applicationId, DEFAULT_SETTINGS.applicationId)
})

test('normalize accepts a plausible application id override and rejects junk', () => {
  assert.equal(
    normalizeSettings({ applicationId: '123456789012345678' }).applicationId,
    '123456789012345678'
  )
  assert.equal(
    normalizeSettings({ applicationId: 'not-a-snowflake' }).applicationId,
    DEFAULT_SETTINGS.applicationId
  )
})

test('detail level cycles in a fixed order and wraps', () => {
  assert.deepEqual(DETAIL_LEVELS, ['off', 'generic', 'workspace', 'full'])
  assert.equal(nextDetailLevel('generic'), 'workspace')
  assert.equal(nextDetailLevel('full'), 'off')
})

test('toggleField flips exactly one boolean', () => {
  const next = toggleField(DEFAULT_SETTINGS, 'showBranch')
  assert.equal(next.showBranch, true)
  assert.equal(next.showMachine, DEFAULT_SETTINGS.showMachine)
  assert.notEqual(next, DEFAULT_SETTINGS)
})

test('toggleField ignores a non-boolean field name', () => {
  assert.deepEqual(toggleField(DEFAULT_SETTINGS, 'detailLevel'), DEFAULT_SETTINGS)
})
