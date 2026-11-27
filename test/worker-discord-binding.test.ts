import { expect, test } from 'bun:test'
import type { DetectedClient } from '../src/discord/detect'
import { createDiscordBinding } from '../src/worker/discord-binding'
import { createDisposer, type OrcaHost } from '../src/worker/host'
import { createSettingsRuntime } from '../src/worker/settings-runtime'

function fakeClientFactory() {
  const created: Array<{ clientId: string; candidates?: () => string[] }> = []
  const sets: number[] = []
  const makeDiscordClient = (options: { clientId: string; candidates?: () => string[] }) => {
    const idx = created.length
    created.push(options)
    let path: string | null = null
    return {
      connect: async () => {
        path = options.candidates?.()[0] ?? null
      },
      isConnected: () => path !== null,
      connectedPath: () => path,
      setActivity: async () => {
        sets.push(idx)
        return null
      },
      clearActivity: async () => null,
      close: async () => {
        path = null
      },
      destroySocketForTest: () => {}
    }
  }
  return { created, sets, makeDiscordClient }
}

function minimalOrca(stored: Record<string, unknown> = {}): OrcaHost {
  return {
    log: () => {},
    commands: { register: () => {} },
    events: { on: () => {} },
    host: {
      has: () => false,
      call: async (method) => (method === 'settings.get' ? { settings: stored } : null)
    }
  }
}

test('auto-rebind on chosen client takeover inherits Clear hold; user setting change releases it', async () => {
  const discord: DetectedClient = { id: 'discord:0', label: 'Discord', path: '/run/user/1/discord-ipc-0' }
  const vesktop: DetectedClient = { id: 'vesktop:0', label: 'Vesktop', path: '/run/user/1/vesktop/discord-ipc-0' }
  let detected: DetectedClient[] = [discord]
  const fake = fakeClientFactory()
  const disposer = createDisposer()
  const runtime = await createSettingsRuntime({
    orca: minimalOrca({ discordClient: 'vesktop:0' }),
    disposer,
    env: {}
  })

  let republishes = 0
  const binding = createDiscordBinding({
    settingsRuntime: runtime,
    disposer,
    log: () => {},
    detectClients: async () => detected,
    makeDiscordClient: fake.makeDiscordClient as never,
    onHealthChange: () => {},
    onNeedsHistory: async () => {},
    onRepublish: async () => {
      republishes += 1
    },
    onAfterApply: () => {}
  })

  await binding.redetect(true)
  await binding.controller().update({ displayName: 'repo', agentState: 'working' })
  await binding.controller().clear()
  expect(binding.controller().status().heldClear).toBe(true)

  // Vesktop appears -> automatic takeover rebind MUST preserve Clear hold and return rebound: true.
  detected = [discord, vesktop]
  const result = await binding.redetect(true)
  expect(result).toEqual({ rebound: true })
  expect(binding.controller().status().heldClear).toBe(true)
  expect(republishes).toBe(0)

  // User changes discordClient -> releases Clear hold and republishes.
  await binding.applySettings({ ...runtime.current(), discordClient: 'discord:0' })
  expect(binding.controller().status().heldClear).toBe(false)
  expect(republishes).toBe(1)

  await binding.stop()
  disposer.disposeAll()
})

test('enabling session stats publishes counts in one activity write', async () => {
  const fake = fakeClientFactory()
  const disposer = createDisposer()
  const runtime = await createSettingsRuntime({ orca: minimalOrca(), disposer, env: {} })
  let historyCalls = 0
  let republishes = 0
  const binding = createDiscordBinding({
    settingsRuntime: runtime,
    disposer,
    log: () => {},
    detectClients: async () => [],
    makeDiscordClient: fake.makeDiscordClient as never,
    onHealthChange: () => {},
    onNeedsHistory: async () => { historyCalls += 1 },
    getSessionStats: () => ({ tokens: 123, messages: 4 }),
    onRepublish: async () => { republishes += 1 },
    onAfterApply: () => {}
  })
  await binding.controller().update({ displayName: 'repo', agentState: 'working' })
  fake.sets.length = 0
  await binding.applySettings({ ...runtime.current(), showSessionStats: 'tokens' })
  expect(historyCalls).toBe(1)
  expect(fake.sets).toHaveLength(1)
  expect(republishes).toBe(0)
  expect(JSON.stringify(binding.controller().status().lastActivity)).toContain('123')
  await binding.stop()
  disposer.disposeAll()
})
