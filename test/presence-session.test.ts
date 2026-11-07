import { expect, test } from 'bun:test'
import { SESSION_GAP_MS } from '../src/presence/expiry'
import { createSessionClock } from '../src/presence/session'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T = 10_000 * MINUTE

function harness(start = T) {
  let now = start
  const clock = createSessionClock({ gapMs: SESSION_GAP_MS, now: () => now })
  return { clock, advance: (ms: number) => (now += ms) }
}

test('startMs undefined before first touch', () => {
  const { clock } = harness()
  expect(clock.startMs()).toBeUndefined()
  expect(clock.toJSON()).toBeNull()
})

test('first touch starts a session', () => {
  const { clock } = harness()
  clock.touch()
  expect(clock.startMs()).toBe(T)
})

test('touch inside gap keeps start', () => {
  const { clock, advance } = harness()
  clock.touch()
  advance(29 * MINUTE)
  clock.touch()
  expect(clock.startMs()).toBe(T)
  advance(29 * MINUTE)
  clock.touch()
  expect(clock.startMs()).toBe(T)
})

test('touch after gap restarts', () => {
  const { clock, advance } = harness()
  clock.touch()
  advance(31 * MINUTE)
  clock.touch()
  expect(clock.startMs()).toBe(T + 31 * MINUTE)
})

test('session lapses after gap without touch', () => {
  const { clock, advance } = harness()
  clock.touch()
  advance(30 * MINUTE)
  expect(clock.startMs()).toBe(T)
  advance(1 * MINUTE)
  expect(clock.startMs()).toBeUndefined()
  clock.touch()
  expect(clock.startMs()).toBe(T + 31 * MINUTE)
})

test('restore inside gap keeps start', () => {
  const { clock } = harness()
  clock.restore({ startMs: T - 2 * HOUR, lastActiveMs: T - 10 * MINUTE })
  clock.touch()
  expect(clock.startMs()).toBe(T - 2 * HOUR)
})

test('restore outside gap is dropped', () => {
  const { clock } = harness()
  clock.restore({ startMs: T - 2 * HOUR, lastActiveMs: T - 40 * MINUTE })
  expect(clock.startMs()).toBeUndefined()
  clock.touch()
  expect(clock.startMs()).toBe(T)
})

test('restore ignores bad input', () => {
  const bad: unknown[] = [
    null,
    'x',
    {},
    { startMs: 'a', lastActiveMs: 1 },
    { startMs: T, lastActiveMs: T + 5 * MINUTE },
    { startMs: T + 1, lastActiveMs: T }
  ]
  for (const value of bad) {
    const { clock } = harness()
    expect(() => clock.restore(value)).not.toThrow()
    expect(clock.startMs()).toBeUndefined()
  }
})

test('toJSON round-trips', () => {
  const a = harness()
  a.clock.touch()
  a.advance(5 * MINUTE)
  a.clock.touch()
  const b = harness(T + 5 * MINUTE)
  b.clock.restore(a.clock.toJSON())
  expect(b.clock.startMs()).toBe(a.clock.startMs())
})
