import { expect, test } from 'bun:test'
import type { DiscordActivity } from '../src/presence/activity'
import type { PresenceBridge } from '../src/presence/bridge'
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
  const bridged: Array<DiscordActivity | 'clear'> = []
  const logs: string[] = []
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
      if (client.connected) {
        activities.push(null)
      }
      client.connected = false
    }
  }
  const bridge: PresenceBridge = {
    publish: async (_url, _token, activity) => {
      bridged.push(activity)
    },
    clear: async () => {
      bridged.push('clear')
    }
  }
  const controller = createPresenceController({
    client,
    bridge,
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
    log: (message) => {
      logs.push(message)
    }
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
  return { controller, client, activities, bridged, logs, advance, nowRef: () => now }
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

test('forceTransmit re-sends an unchanged activity', async () => {
  const { controller, activities } = harness()
  const snapshot = { displayName: 'repo', agentState: 'working', terminalCount: 1 }
  await controller.update(snapshot)
  expect(activities.length).toBe(1)
  await controller.forceTransmit()
  expect(activities.length).toBe(2)
  expect(activities[1] && 'details' in activities[1] ? activities[1].details : null).toBe('repo')
})

test('skip-identical cannot strand Discord after another client overwrote activity', async () => {
  const { controller, activities, advance } = harness()
  const snapshot = { displayName: 'repo', agentState: 'working', terminalCount: 1 }
  await controller.update(snapshot)
  await controller.update({ ...snapshot })
  await advance(MIN_UPDATE_INTERVAL_MS * 2)
  expect(activities.length).toBe(1)
  // Heartbeat / Show Status: forceTransmit must republish even though JSON matches.
  await controller.forceTransmit()
  expect(activities.length).toBe(2)
  expect(activities[1] && 'details' in activities[1] ? activities[1].details : null).toBe('repo')
})

test('an empty snapshot still publishes generic Working in Orca', async () => {
  const { controller, activities } = harness({ detailLevel: 'generic' })
  await controller.update({})
  expect(activities.length).toBe(1)
  expect(activities[0] && 'details' in activities[0] ? activities[0].details : null).toBe(
    'Working in Orca'
  )
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
  const { controller, client, activities, logs } = harness()
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
  expect(logs.some((line) => line.includes('discord.connect_failed'))).toBe(true)
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

test('stop is idempotent and does not double-close', async () => {
  const { controller, client, activities } = harness()
  let closes = 0
  const innerClose = client.close
  client.close = async () => {
    closes++
    await innerClose()
  }
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.stop()
  await controller.stop()
  expect(closes).toBe(1)
  expect(activities.filter((entry) => entry === null).length).toBeGreaterThanOrEqual(1)
  expect(client.isConnected()).toBe(false)
})

test('reload closes IPC and re-SET_ACTIVITY', async () => {
  const { controller, client, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  expect(activities.length).toBe(1)
  expect(client.isConnected()).toBe(true)
  await controller.reload()
  expect(client.isConnected()).toBe(true)
  expect(activities.filter((entry) => entry === null).length).toBeGreaterThanOrEqual(1)
  expect(activities.at(-1) && 'details' in (activities.at(-1) as object) ? (activities.at(-1) as { details: string }).details : null).toBe(
    'repo'
  )
  expect(activities.length).toBeGreaterThan(1)
})

test('prefers local IPC and does not dual-publish when Discord is connected', async () => {
  const { controller, activities, bridged } = harness({
    bridgeEnabled: true,
    bridgeUrl: 'http://127.0.0.1:3848',
    bridgeToken: 'tok'
  })
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  expect(activities.length).toBe(1)
  expect(bridged.length).toBe(0)
  expect(controller.status().sink).toBe('local')
  expect(controller.status().bridgeEnabled).toBe(true)
})

test('falls back to the companion when local Discord IPC is unavailable', async () => {
  const { controller, client, activities, bridged } = harness({
    bridgeEnabled: true,
    bridgeUrl: 'http://100.64.1.2:3848',
    bridgeToken: 'tok'
  })
  client.connect = async () => {
    throw new Error('no discord ipc socket accepted a connection')
  }
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  expect(activities.length).toBe(0)
  expect(bridged.length).toBe(1)
  expect(bridged[0] && bridged[0] !== 'clear' ? bridged[0].details : null).toBe('repo')
  expect(controller.status().connected).toBe(false)
  expect(controller.status().sink).toBe('bridge')
})

test('stop after a bridge publish clears the remote activity', async () => {
  const { controller, client, bridged } = harness({
    bridgeEnabled: true,
    bridgeUrl: 'http://100.64.1.2:3848',
    bridgeToken: 'tok'
  })
  client.connect = async () => {
    throw new Error('no discord ipc socket accepted a connection')
  }
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.stop()
  expect(bridged.at(-1)).toBe('clear')
  expect(controller.status().sink).toBeNull()
})

test('clear sends SET_ACTIVITY null without disabling', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  expect(controller.settings().enabled).toBe(true)
  await controller.clear()
  expect(activities.at(-1)).toBeNull()
  expect(controller.settings().enabled).toBe(true)
  expect(controller.status().heldClear).toBe(true)
  expect(controller.status().lastActivity).toBeNull()
})

test('clear after a bridge publish clears the remote activity', async () => {
  const { controller, client, bridged } = harness({
    bridgeEnabled: true,
    bridgeUrl: 'http://100.64.1.2:3848',
    bridgeToken: 'tok'
  })
  client.connect = async () => {
    throw new Error('no discord ipc socket accepted a connection')
  }
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.clear()
  expect(bridged.at(-1)).toBe('clear')
  expect(controller.status().sink).toBeNull()
  expect(controller.status().heldClear).toBe(true)
})

test('heartbeat forceTransmit does not lift a clear hold', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.clear()
  const afterClear = activities.length
  await controller.forceTransmit()
  expect(activities.length).toBe(afterClear)
  expect(controller.status().heldClear).toBe(true)
})

test('an agent update with resume republishes after clear', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.clear()
  await controller.update({ displayName: 'repo', agentState: 'blocked', terminalCount: 1 }, { resume: true })
  expect(controller.status().heldClear).toBe(false)
  expect(activities.at(-1) && 'state' in (activities.at(-1) as object) ? (activities.at(-1) as { state: string }).state : null).toBe(
    'blocked'
  )
})

test('Show Status forceTransmit(true) lifts a clear hold', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.clear()
  await controller.forceTransmit(true)
  expect(controller.status().heldClear).toBe(false)
  expect(activities.at(-1) && 'details' in (activities.at(-1) as object) ? (activities.at(-1) as { details: string }).details : null).toBe(
    'repo'
  )
})

test('clear is idempotent', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.clear()
  await controller.clear()
  expect(activities.filter((entry) => entry === null).length).toBe(1)
})

test('setSettings lifts a clear hold and republishes', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.clear()
  await controller.setSettings({ ...DEFAULT_SETTINGS, detailLevel: 'full', showTerminals: true })
  expect(controller.status().heldClear).toBe(false)
  expect(activities.at(-1)).not.toBeNull()
})

test('disabling the bridge after a remote publish clears the companion', async () => {
  const { controller, client, bridged } = harness({
    bridgeEnabled: true,
    bridgeUrl: 'http://100.64.1.2:3848',
    bridgeToken: 'tok'
  })
  client.connect = async () => {
    throw new Error('no discord ipc socket accepted a connection')
  }
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.setSettings({
    ...DEFAULT_SETTINGS,
    detailLevel: 'full',
    bridgeEnabled: false,
    bridgeUrl: 'http://100.64.1.2:3848',
    bridgeToken: 'tok'
  })
  expect(bridged.filter((entry) => entry === 'clear').length).toBe(1)
  expect(controller.status().sink).toBeNull()
})

