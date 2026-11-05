import { expect, test } from 'bun:test'
import { createTimeline, timelineStateFor, TIMELINE_MINUTES } from '../src/presence/timeline'

const MINUTE = 60_000

function harness(start = 10_000 * MINUTE) {
  let now = start
  const timeline = createTimeline({ now: () => now })
  return { timeline, advance: (ms: number) => (now += ms) }
}

test('slots length is 30 and null before first record', () => {
  const { timeline } = harness()
  expect(TIMELINE_MINUTES).toBe(30)
  expect(timeline.slots()).toEqual(new Array(30).fill(null))
  timeline.record('working')
  const slots = timeline.slots()
  expect(slots).toHaveLength(30)
  expect(slots.slice(0, 29).every((slot) => slot === null)).toBe(true)
  expect(slots[29]).toBe('working')
})

test('blocked beats working inside one minute', () => {
  const { timeline } = harness()
  timeline.record('working')
  timeline.record('blocked')
  timeline.record('idle')
  expect(timeline.slots()[29]).toBe('blocked')
})

test('working beats completed inside one minute, in either order', () => {
  const a = harness()
  a.timeline.record('completed')
  a.timeline.record('working')
  expect(a.timeline.slots()[29]).toBe('working')
  const b = harness()
  b.timeline.record('working')
  b.timeline.record('completed')
  expect(b.timeline.slots()[29]).toBe('working')
})

test('completed beats idle inside one minute', () => {
  const { timeline } = harness()
  timeline.record('idle')
  timeline.record('completed')
  timeline.record('idle')
  expect(timeline.slots()[29]).toBe('completed')
})

test('agent summary state maps to a timeline state: done is completed, none is idle', () => {
  expect(timelineStateFor('done')).toBe('completed')
  expect(timelineStateFor(undefined)).toBe('idle')
  expect(timelineStateFor('idle')).toBe('idle')
  expect(timelineStateFor('working')).toBe('working')
  expect(timelineStateFor('waiting')).toBe('waiting')
  expect(timelineStateFor('blocked')).toBe('blocked')
})

test('empty minutes carry forward last state', () => {
  const { timeline, advance } = harness()
  timeline.record('working')
  advance(5 * MINUTE)
  expect(timeline.slots().slice(-6)).toEqual(new Array(6).fill('working'))
  expect(timeline.slots()[23]).toBe(null)
})

test('oldest visible minute carries state from before the window after a prune', () => {
  const { timeline, advance } = harness()
  timeline.record('working')
  advance(40 * MINUTE)
  timeline.record('waiting')
  const slots = timeline.slots()
  expect(slots[0]).toBe('working')
  expect(slots[29]).toBe('waiting')
  expect(slots.includes(null)).toBe(false)
})
