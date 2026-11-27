import { expect, test } from 'bun:test'
import { createAgentTable } from '../src/presence/agents'
import { createLogRing } from '../src/presence/log-ring'
import { createDiscordBinding } from '../src/worker/discord-binding'
import { createDisposer, type OrcaHost } from '../src/worker/host'
import { createHostSync } from '../src/worker/host-sync'
import { createPanelRpc } from '../src/worker/panel-rpc'
import { createPersistence } from '../src/worker/persistence'
import { createSettingsRuntime } from '../src/worker/settings-runtime'

test('panel-rpc registers all disposables, enforces focus-agent/run contracts, and disposes cleanly', async () => {
  const handlers = new Map<string, (input: unknown) => unknown>()
  const disposedNames: string[] = []
  const focused: string[] = []
  let clock = 10_000

  const orca: OrcaHost = {
    log: () => {},
    commands: { register: () => {} },
    events: { on: () => {} },
    host: {
      has: (method) => ['terminal.focus', 'agents.list'].includes(method),
      call: async (method, args) => {
        if (method === 'settings.get') return { settings: {} }
        if (method === 'terminal.focus') {
          focused.push(String(args?.terminalId ?? ''))
          return { focused: true }
        }
        return null
      }
    },
    panels: {
      handle: (name, fn) => {
        handlers.set(name, fn)
        return {
          dispose: () => {
            disposedNames.push(name)
            handlers.delete(name)
          }
        }
      },
      post: () => {}
    }
  }

  const disposer = createDisposer()
  const settingsRuntime = await createSettingsRuntime({ orca, disposer, env: {} })
  const agentTable = createAgentTable({ now: () => clock })
  agentTable.upsert({
    workspaceId: 'w1',
    paneKey: 'p1',
    terminalId: 'term-secret-9',
    kind: 'claude',
    state: 'working',
    receivedAt: clock
  })
  const persistence = await createPersistence({ host: orca.host, disposer, now: () => clock })
  const hostSync = createHostSync({ host: orca.host, agentTable, disposer, now: () => clock })
  const binding = createDiscordBinding({
    settingsRuntime,
    disposer,
    log: () => {},
    detectClients: async () => [],
    makeDiscordClient: (() => ({
      connect: async () => {},
      isConnected: () => false,
      connectedPath: () => null,
      setActivity: async () => null,
      clearActivity: async () => null,
      close: async () => {},
      destroySocketForTest: () => {}
    })) as never,
    onHealthChange: () => {},
    onNeedsHistory: async () => {},
    onRepublish: async () => {},
    onAfterApply: () => {}
  })

  const rpc = createPanelRpc({
    orca,
    disposer,
    binding,
    settingsRuntime,
    persistence,
    hostSync,
    agentTable,
    logRing: createLogRing(),
    now: () => clock
  })

  let ran = 0
  rpc.register({
    paletteHandlers: new Map([
      [
        'presence.toggle',
        async () => {
          ran += 1
        }
      ]
    ]),
    refresh: async () => {}
  })

  const snap = (await handlers.get('presence.snapshot')?.({})) as {
    agents: Array<{ focusKey?: string }>
  }
  const key = snap.agents[0]?.focusKey
  expect(key).toBeDefined()
  expect(JSON.stringify(snap)).not.toContain('term-secret-9')

  expect(await handlers.get('presence.focus-agent')?.({ key })).toEqual({ ok: true, focused: true })
  expect(focused).toEqual(['term-secret-9'])
  await expect(
    Promise.resolve().then(() => handlers.get('presence.focus-agent')?.({ key: '' }))
  ).rejects.toMatchObject({ code: 'invalid_params' })

  expect(await handlers.get('presence.run')?.({ command: 'presence.toggle' })).toEqual({ ok: true })
  expect(ran).toBe(1)
  await expect(
    Promise.resolve().then(() => handlers.get('presence.run')?.({ command: 'presence.configure' }))
  ).rejects.toMatchObject({ code: 'invalid_params' })

  // Dispose must clean up every single panels.handle() registration!
  disposer.disposeAll()
  expect(disposedNames.sort()).toEqual([
    'presence.focus-agent',
    'presence.refresh',
    'presence.run',
    'presence.snapshot'
  ])
  expect(handlers.size).toBe(0)
  expect(rpc.currentSnapshot()).toBeNull()

  await binding.stop()
  agentTable.clear()
})
