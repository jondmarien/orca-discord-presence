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

test('fork field args apply and reject junk', () => {
  const result = applyConfigure(DEFAULT_SETTINGS, {
    showFocusedSurface: true,
    focusedSurfaceDetail: 'kind+title',
    showAgentType: true,
    showAgentModel: true,
    showAgentProfile: true
  })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.settings.showFocusedSurface).toBe(true)
    expect(result.settings.focusedSurfaceDetail).toBe('kind+title')
    expect(result.settings.showAgentType).toBe(true)
    expect(result.settings.showAgentModel).toBe(true)
    expect(result.settings.showAgentProfile).toBe(true)
  }
  expect(applyConfigure(DEFAULT_SETTINGS, { focusedSurfaceDetail: 'everything' }).ok).toBe(false)
  expect(applyConfigure(DEFAULT_SETTINGS, { showAgentType: 'yes' }).ok).toBe(false)
})
