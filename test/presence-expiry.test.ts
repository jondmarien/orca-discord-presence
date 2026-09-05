import { expect, test } from 'bun:test'
import { ACTIVITY_EXPIRY_MS, isActivityFresh } from '../src/presence/expiry'

test('Burpcord-style windows are 30s short and 60s long', () => {
  expect(ACTIVITY_EXPIRY_MS.short).toBe(30_000)
  expect(ACTIVITY_EXPIRY_MS.long).toBe(60_000)
})

test('isActivityFresh is true only inside the window', () => {
  const lastSeen = 1_000_000
  expect(isActivityFresh(lastSeen, lastSeen + 29_999, ACTIVITY_EXPIRY_MS.short)).toBe(true)
  expect(isActivityFresh(lastSeen, lastSeen + 30_000, ACTIVITY_EXPIRY_MS.short)).toBe(false)
  expect(isActivityFresh(lastSeen, lastSeen + 59_999, ACTIVITY_EXPIRY_MS.long)).toBe(true)
  expect(isActivityFresh(lastSeen, lastSeen + 60_000, ACTIVITY_EXPIRY_MS.long)).toBe(false)
})

test('invalid clocks and non-positive windows are stale', () => {
  expect(isActivityFresh(Number.NaN, 1, 30_000)).toBe(false)
  expect(isActivityFresh(1, Number.POSITIVE_INFINITY, 30_000)).toBe(false)
  expect(isActivityFresh(1, 2, 0)).toBe(false)
  expect(isActivityFresh(1, 2, -1)).toBe(false)
})
