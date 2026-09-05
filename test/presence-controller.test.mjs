import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPresenceController, MIN_UPDATE_INTERVAL_MS } from '../src/presence-controller.mjs'
import { DEFAULT_SETTINGS } from '../src/presence-settings.mjs'

function harness(overrides = {}) {
  let now = 1_000_000
  const activities = []
  const timers = []
  const client = {
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
      const timer = { fn, at: now + ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      if (timer) {
        timer.cancelled = true
      }
    },
    log: () => {}
  })
  const advance = async (ms) => {
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
  assert.equal(activities.length, 1)
  assert.equal(activities[0].details, 'repo')
})

test('a burst inside the rate-limit window collapses to one deferred write', async () => {
  const { controller, activities, advance } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.update({ displayName: 'repo', agentState: 'blocked', terminalCount: 1 })
  await controller.update({ displayName: 'repo', agentState: 'waiting', terminalCount: 1 })
  assert.equal(activities.length, 1)
  await advance(MIN_UPDATE_INTERVAL_MS)
  assert.equal(activities.length, 2)
  // Coalesced to the newest state, not replayed in order.
  assert.equal(activities[1].state, 'waiting for input')
})

test('an identical snapshot does not schedule a redundant write', async () => {
  const { controller, activities, advance } = harness()
  const snapshot = { displayName: 'repo', agentState: 'working', terminalCount: 1 }
  await controller.update(snapshot)
  await controller.update({ ...snapshot })
  await advance(MIN_UPDATE_INTERVAL_MS * 2)
  assert.equal(activities.length, 1)
})

test('disabling clears the presence exactly once', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.setSettings({ ...DEFAULT_SETTINGS, enabled: false })
  assert.equal(activities.at(-1), null)
  await controller.setSettings({ ...DEFAULT_SETTINGS, enabled: false })
  assert.equal(activities.filter((entry) => entry === null).length, 1)
})

test('detail level off clears the presence like disabling does', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.setSettings({ ...DEFAULT_SETTINGS, detailLevel: 'off' })
  assert.equal(activities.at(-1), null)
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
  assert.equal(activities.length, 0)
  await controller.update({ displayName: 'repo', agentState: 'blocked', terminalCount: 1 })
  assert.equal(activities.length, 1)
})

test('status reports connection state and the last transmitted activity', async () => {
  const { controller } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  const status = controller.status()
  assert.equal(status.connected, true)
  assert.equal(status.enabled, true)
  assert.equal(status.lastActivity.details, 'repo')
})

test('stop clears presence and closes the client', async () => {
  const { controller, client, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.stop()
  assert.equal(activities.at(-1), null)
  assert.equal(client.isConnected(), false)
})
