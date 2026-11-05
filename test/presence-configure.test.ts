import { expect, test } from 'bun:test'
import { applyConfigure } from '../src/presence/configure'
import { DEFAULT_SETTINGS, SHIPPED_APPLICATION_ID } from '../src/presence/settings'

test('applyConfigure with no args is a no-op', () => {
  const result = applyConfigure(DEFAULT_SETTINGS, undefined)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.changed).toEqual([])
    expect(result.settings).toEqual(DEFAULT_SETTINGS)
  }
})

test('empty applicationId restores the shipped snowflake', () => {
  const current = { ...DEFAULT_SETTINGS, applicationId: '123456789012345678' }
  const result = applyConfigure(current, { applicationId: '  ' })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.settings.applicationId).toBe(SHIPPED_APPLICATION_ID)
    expect(result.changed).toContain('applicationId')
  }
})

test('a valid applicationId override is persisted', () => {
  const result = applyConfigure(DEFAULT_SETTINGS, { applicationId: '123456789012345678' })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.settings.applicationId).toBe('123456789012345678')
  }
})

test('an invalid applicationId fails fast and does not persist', () => {
  const result = applyConfigure(DEFAULT_SETTINGS, { applicationId: 'not-a-snowflake' })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error).toMatch(/17–20 digit|snowflake/i)
  }
})

test('a valid https openUrl and button flag are applied', () => {
  const result = applyConfigure(DEFAULT_SETTINGS, {
    openUrl: 'https://orca.example',
    showOpenButton: true,
    openButtonLabel: 'Open docs',
    showAgentCount: true
  })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.settings.openUrl).toBe('https://orca.example')
    expect(result.settings.showOpenButton).toBe(true)
    expect(result.settings.openButtonLabel).toBe('Open docs')
    expect(result.settings.showAgentCount).toBe(true)
    expect(result.changed.sort()).toEqual(
      ['openButtonLabel', 'openUrl', 'showAgentCount', 'showOpenButton'].sort()
    )
  }
})

test('an invalid openUrl fails fast', () => {
  const result = applyConfigure(DEFAULT_SETTINGS, { openUrl: 'http://insecure.example' })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error).toMatch(/https/i)
  }
})

test('empty openUrl clears the stored URL', () => {
  const current = { ...DEFAULT_SETTINGS, openUrl: 'https://orca.example', showOpenButton: true }
  const result = applyConfigure(current, { openUrl: '' })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.settings.openUrl).toBe('')
  }
})

test('wrong types fail fast', () => {
  expect(applyConfigure(DEFAULT_SETTINGS, { showOpenButton: 'yes' }).ok).toBe(false)
  expect(applyConfigure(DEFAULT_SETTINGS, 'nope').ok).toBe(false)
})

test('bridgeToken is trimmed, applied and reported as changed', () => {
  const result = applyConfigure(DEFAULT_SETTINGS, { bridgeToken: '  tok  ' })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.settings.bridgeToken).toBe('tok')
    expect(result.changed).toEqual(['bridgeToken'])
  }
})

test('an empty bridgeToken clears it; an unchanged one is not a change', () => {
  const current = { ...DEFAULT_SETTINGS, bridgeToken: 'tok' }
  const cleared = applyConfigure(current, { bridgeToken: '' })
  expect(cleared.ok && cleared.settings.bridgeToken).toBe('')
  const same = applyConfigure(current, { bridgeToken: 'tok' })
  expect(same.ok && same.changed).toEqual([])
})

test('a non-string bridgeToken fails fast', () => {
  const result = applyConfigure(DEFAULT_SETTINGS, { bridgeToken: 42 })
  expect(result.ok).toBe(false)
})
