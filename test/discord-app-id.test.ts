import { expect, test } from 'bun:test'
import {
  assertPlausibleApplicationId,
  inspectApplicationId,
  isPlausibleApplicationId
} from '../src/discord/app-id'
import { SHIPPED_APPLICATION_ID } from '../src/presence/settings'

test('the shipped snowflake is accepted', () => {
  expect(isPlausibleApplicationId(SHIPPED_APPLICATION_ID)).toBe(true)
  const inspection = inspectApplicationId(SHIPPED_APPLICATION_ID, SHIPPED_APPLICATION_ID)
  expect(inspection.applicationId).toBe(SHIPPED_APPLICATION_ID)
  expect(inspection.usedFallback).toBe(false)
})

test('a 17–20 digit override is accepted', () => {
  expect(inspectApplicationId('123456789012345678', SHIPPED_APPLICATION_ID).applicationId).toBe(
    '123456789012345678'
  )
})

test('missing raw is not a rejection', () => {
  const inspection = inspectApplicationId(undefined, SHIPPED_APPLICATION_ID)
  expect(inspection.usedFallback).toBe(false)
  expect(inspection.applicationId).toBe(SHIPPED_APPLICATION_ID)
})

test('junk and empty ids fail-fast to the shipped fallback', () => {
  const junk = inspectApplicationId('not-a-snowflake', SHIPPED_APPLICATION_ID)
  expect(junk.usedFallback).toBe(true)
  expect(junk.rejectedRaw).toBe('not-a-snowflake')
  expect(junk.applicationId).toBe(SHIPPED_APPLICATION_ID)
  expect(junk.reason).toMatch(/17–20 digit/i)

  const empty = inspectApplicationId('   ', SHIPPED_APPLICATION_ID)
  expect(empty.usedFallback).toBe(true)
  expect(empty.rejectedRaw).toBe('')
})

test('assertPlausibleApplicationId throws on obvious junk', () => {
  expect(() => assertPlausibleApplicationId('abc')).toThrow(/application id is invalid/i)
  expect(() => assertPlausibleApplicationId(SHIPPED_APPLICATION_ID)).not.toThrow()
})
