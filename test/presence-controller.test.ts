import { expect, test } from 'bun:test'
import type { DiscordActivity } from '../src/presence/activity'
import { createPresenceController, MIN_UPDATE_INTERVAL_MS, type PresenceClient } from '../src/presence/controller'
import { DEFAULT_SETTINGS, type PresenceSettings } from '../src/presence/settings'

type FakeTimer = {
  fn: () => void | Promise<void>
  at: number
  cancelled: boolean
}

function harness(overrides: Partial<PresenceSettings> = {}) {
  let now = 1_000_000
  const activities: Array<DiscordActivity | null> = []
  const timers: FakeTimer[] = []
  const client: PresenceClient & { connected: boolean } = {
    connected: false,
    connect: async () => {
      client.connected = true
    },
    isConnected: () => client.connected,
    setActivity: async (activity) => {
      activities.push(activity)
    },
    clearActivity: async () => {
      activities.push(null)
    },
    close: async () => {
      client.connected = false
    }
  }
  const controller = createPresenceController({
    client,
    settings: { ...DEFAULT_SETTINGS, detailLevel: 'full', ...overrides },
    now: () => now,
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { fn, at: now + ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      if (timer && typeof timer === 'object' && 'cancelled' in timer) {
        ;(timer as FakeTimer).cancelled = true
      }
    },
    log: () => {}
  })
  const advance = async (ms: number) => {
    now += ms
    for (const timer of [...timers]) {
      if (!timer.cancelled && timer.at <= now) {
        timer.cancelled = true
        await timer.fn()
      }
    }
  }
  return { controller, client, activities, advance, nowRef: () => now }
}

test('the first update writes through immediately', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  expect(activities.length).toBe(1)
  expect(activities[0] && 'details' in activities[0] ? activities[0].details : null).toBe('repo')
})

test('a burst inside the rate-limit window collapses to one deferred write', async () => {
  const { controller, activities, advance } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.update({ displayName: 'repo', agentState: 'blocked', terminalCount: 1 })
  await controller.update({ displayName: 'repo', agentState: 'waiting', terminalCount: 1 })
  expect(activities.length).toBe(1)
  await advance(MIN_UPDATE_INTERVAL_MS)
  expect(activities.length).toBe(2)
  // Coalesced to the newest state, not replayed in order.
  expect(activities[1] && 'state' in activities[1] ? activities[1].state : null).toBe(
    'waiting for input'
  )
})

test('an identical snapshot does not schedule a redundant write', async () => {
  const { controller, activities, advance } = harness()
  const snapshot = { displayName: 'repo', agentState: 'working', terminalCount: 1 }
  await controller.update(snapshot)
  await controller.update({ ...snapshot })
  await advance(MIN_UPDATE_INTERVAL_MS * 2)
  expect(activities.length).toBe(1)
})

test('disabling clears the presence exactly once', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.setSettings({ ...DEFAULT_SETTINGS, enabled: false })
  expect(activities.at(-1)).toBeNull()
  await controller.setSettings({ ...DEFAULT_SETTINGS, enabled: false })
  expect(activities.filter((entry) => entry === null).length).toBe(1)
})

test('detail level off clears the presence like disabling does', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.setSettings({ ...DEFAULT_SETTINGS, detailLevel: 'off' })
  expect(activities.at(-1)).toBeNull()
})

test('a connect failure is swallowed and retried on the next update', async () => {
  const { controller, client, activities } = harness()
  let attempts = 0
  client.connect = async () => {
    attempts++
    if (attempts === 1) {
      throw new Error('no discord ipc socket accepted a connection')
    }
    client.connected = true
  }
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  expect(activities.length).toBe(0)
  await controller.update({ displayName: 'repo', agentState: 'blocked', terminalCount: 1 })
  expect(activities.length).toBe(1)
})

test('status reports connection state and the last transmitted activity', async () => {
  const { controller } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  const status = controller.status()
  expect(status.connected).toBe(true)
  expect(status.enabled).toBe(true)
  expect(status.lastActivity?.details).toBe('repo')
})

test('stop clears presence and closes the client', async () => {
  const { controller, client, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.stop()
  expect(activities.at(-1)).toBeNull()
  expect(client.isConnected()).toBe(false)
})
