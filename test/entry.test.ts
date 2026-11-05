import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import vm from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DISCORD_IPC_ENV } from '../src/discord/ipc'
import { formatStatusTransmitting, toSettingsValue, type OrcaHost } from '../src/main'
import { LOG_DIR_NAME, LOG_PLUGIN_ID } from '../src/presence/log'
import { snapshotLeaksSecrets, type PresencePanelSnapshot } from '../src/presence/panel-snapshot'
import { PLUGIN_VERSION } from '../src/version'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Why: activate() starts the controller, which dials Discord IPC. A live
// Discord/Vesktop socket on the dev machine would make tests hang, so point
// discovery at a path that never exists.
const ipcDir = mkdtempSync(join(os.tmpdir(), 'orca-presence-ipc-'))
const previousIpc = process.env[DISCORD_IPC_ENV]
beforeAll(() => {
  process.env[DISCORD_IPC_ENV] = join(ipcDir, 'discord-ipc-none')
})
afterAll(() => {
  if (previousIpc === undefined) {
    delete process.env[DISCORD_IPC_ENV]
  } else {
    process.env[DISCORD_IPC_ENV] = previousIpc
  }
  rmSync(ipcDir, { recursive: true, force: true })
})

test('manifest identity is jondmarien.discord-presence on manifest v2', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')) as {
    manifestVersion: number
    execution: string
    id: string
    publisher?: string
    name: string
    version: string
    license: string
    engines: { orca: string }
    contributes: {
      panels: Array<{ id: string; title: string; icon?: string; entry: string }>
      commands: Array<{ id: string; title: string }>
      events: Array<{ on: string }>
    }
    capabilities: Array<{ kind: string }>
  }
  expect('publisher' in manifest).toBe(false)
  expect(manifest.manifestVersion).toBe(2)
  expect(manifest.execution).toBe('trusted-worker')
  expect(manifest.engines.orca).toBe('>=1.4.248')
  expect(manifest.license).toBe('MIT')
  expect(manifest.name).toBe('Rich Presence for Discord')
  expect(manifest.id).toBe('discord-presence')
  expect(manifest.version).toBe(PLUGIN_VERSION)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  expect(pkg.version).toBe(PLUGIN_VERSION)
  expect(manifest.capabilities.map((cap) => cap.kind).sort()).toEqual(
    [
      'agent:read',
      'notifications:show',
      'secrets:own',
      'settings:own',
      'storage:own',
      'workspace:read'
    ].sort()
  )
  expect(manifest.contributes.events.map((event) => event.on)).toEqual([
    'agent.status.changed',
    'workspace.removed',
    'workspace.changed'
  ])
  expect(manifest.contributes.panels).toEqual([
    { id: 'presence', title: 'Rich Presence', icon: 'activity', entry: 'panel/index.html' }
  ])
  expect(manifest.contributes.commands).toHaveLength(15)
  expect(manifest.contributes.commands.every((command) => command.title.startsWith('Rich Presence: '))).toBe(
    true
  )
  expect(manifest.contributes.commands.some((command) => command.id === 'presence.reload')).toBe(true)
  expect(LOG_PLUGIN_ID).toBe('jondmarien.discord-presence')
  expect(LOG_DIR_NAME).toBe('jondmarien-discord-presence')
  expect(readFileSync(join(root, 'LICENSE'), 'utf8').includes('Copyright (c) 2026 Jonathan Marien')).toBe(true)
})

test('activate and deactivate exports are functions', async () => {
  const mod = await import('../src/main')
  expect(typeof mod.default).toBe('function')
  expect(typeof mod.deactivate).toBe('function')
})

test('activate registers commands and events; deactivate is safe to call', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-entry-'))
  const logFile = join(dir, 'plugin.log')
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = logFile
  const { default: activate, deactivate } = await import('../src/main')
  const commands: string[] = []
  const events: string[] = []
  const hostLines: string[] = []
  const notifications: string[] = []
  const handlers = new Map<string, () => Promise<unknown>>()
  const orca: OrcaHost = {
    log: (message) => {
      hostLines.push(message)
    },
    commands: {
      register: (id, handler) => {
        commands.push(id)
        handlers.set(id, handler)
      }
    },
    events: {
      on: (event) => {
        events.push(event)
      }
    },
    host: {
      has: () => false,
      call: async (method, args) => {
        if (method === 'settings.get') {
          return { settings: {} }
        }
        if (method === 'notifications.show') {
          notifications.push(String(args?.body ?? ''))
          return null
        }
        // Missing workspace context: refresh still applies a minimal snapshot.
        return null
      }
    }
  }
  await activate(orca)
  expect(commands).toEqual([
    'presence.toggle',
    'presence.detail-level',
    'presence.toggle-branch',
    'presence.toggle-agent-state',
    'presence.toggle-terminals',
    'presence.toggle-machine',
    'presence.toggle-elapsed',
    'presence.toggle-bridge',
    'presence.debug-logging',
    'presence.toggle-open-button',
    'presence.toggle-agent-count',
    'presence.status',
    'presence.reload',
    'presence.clear',
    'presence.configure'
  ])
  expect(events).toEqual(['agent.status.changed', 'workspace.removed', 'workspace.changed'])
  expect(hostLines.some((line) => line.includes('activate') && line.includes('jondmarien.discord-presence'))).toBe(
    true
  )
  const onDisk = readFileSync(logFile, 'utf8')
  expect(onDisk.includes('activate')).toBe(true)
  await handlers.get('presence.status')?.()
  expect(notifications.some((body) => body.includes('transmitting='))).toBe(true)
  await handlers.get('presence.reload')?.()
  expect(hostLines.some((line) => line.includes('discord.reload'))).toBe(true)
  expect(notifications.some((body) => body.includes('reloaded'))).toBe(true)
  await deactivate()
  await deactivate()
  if (previous === undefined) {
    delete process.env.ORCA_PRESENCE_LOG_FILE
  } else {
    process.env.ORCA_PRESENCE_LOG_FILE = previous
  }
  rmSync(dir, { recursive: true, force: true })
})

test('an invalid persisted Application ID is logged and toasted', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-appid-'))
  const logFile = join(dir, 'plugin.log')
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = logFile
  const { default: activate, deactivate } = await import('../src/main')
  const hostLines: string[] = []
  const notifications: string[] = []
  const orca: OrcaHost = {
    log: (message) => {
      hostLines.push(message)
    },
    commands: { register: () => {} },
    events: { on: () => {} },
    host: {
      has: () => false,
      call: async (method, args) => {
        if (method === 'settings.get') {
          return { settings: { applicationId: 'not-a-snowflake' } }
        }
        if (method === 'notifications.show') {
          notifications.push(String(args?.body ?? ''))
          return null
        }
        return null
      }
    }
  }
  await activate(orca)
  expect(hostLines.some((line) => line.includes('discord.app_id_invalid'))).toBe(true)
  expect(hostLines.some((line) => /token=/i.test(line) && !line.includes('token=***'))).toBe(false)
  expect(notifications.some((body) => /invalid discord application id/i.test(body))).toBe(true)
  const onDisk = readFileSync(logFile, 'utf8')
  expect(onDisk.includes('discord.app_id_invalid')).toBe(true)
  expect(onDisk.includes('not-a-snowflake')).toBe(true)
  await deactivate()
  if (previous === undefined) {
    delete process.env.ORCA_PRESENCE_LOG_FILE
  } else {
    process.env.ORCA_PRESENCE_LOG_FILE = previous
  }
  rmSync(dir, { recursive: true, force: true })
})

test('configure fails fast on a junk Application ID and accepts two paneKeys', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-configure-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  const { default: activate, deactivate } = await import('../src/main')
  const handlers = new Map<string, (args?: Record<string, unknown>) => Promise<unknown>>()
  const eventHandlers = new Map<string, (payload?: unknown) => Promise<void> | void>()
  const notifications: string[] = []
  const persisted = new Map<string, unknown>()
  const orca: OrcaHost = {
    log: () => {},
    commands: {
      register: (id, handler) => {
        handlers.set(id, handler)
      }
    },
    events: {
      on: (event, handler) => {
        eventHandlers.set(event, handler)
      }
    },
    host: {
      has: () => false,
      call: async (method, args) => {
        if (method === 'settings.get') {
          return { settings: Object.fromEntries(persisted) }
        }
        if (method === 'settings.set') {
          persisted.set(String(args?.key), args?.value)
          return null
        }
        if (method === 'notifications.show') {
          notifications.push(String(args?.body ?? ''))
          return null
        }
        return null
      }
    }
  }
  await activate(orca)
  const junk = (await handlers.get('presence.configure')?.({ applicationId: 'nope' })) as {
    ok: boolean
    error?: string
  }
  expect(junk.ok).toBe(false)
  expect(junk.error).toMatch(/snowflake/i)
  expect(persisted.get('applicationId')).toBeUndefined()

  const configured = (await handlers.get('presence.configure')?.({
    showAgentCount: true,
    openUrl: 'https://orca.example',
    showOpenButton: true
  })) as { ok: boolean; showAgentCount?: boolean; openUrl?: string }
  expect(configured.ok).toBe(true)
  expect(configured.showAgentCount).toBe(true)
  expect(configured.openUrl).toBe('https://orca.example')
  expect(persisted.get('openUrl')).toBe('https://orca.example')
  expect(persisted.get('showAgentCount')).toBe(true)

  const agent = eventHandlers.get('agent.status.changed')
  await agent?.({
    workspaceId: 'wt',
    paneKey: 'a',
    state: 'working',
    receivedAt: Date.now()
  })
  await agent?.({
    workspaceId: 'wt',
    paneKey: 'b',
    state: 'running',
    receivedAt: Date.now()
  })

  const help = (await handlers.get('presence.configure')?.()) as { ok: boolean; hint?: string }
  expect(help.ok).toBe(true)
  expect(help.hint).toMatch(/applicationId/i)

  const clearResult = (await handlers.get('presence.clear')?.()) as { heldClear?: boolean; enabled?: boolean }
  expect(clearResult.enabled).toBe(true)
  expect(clearResult.heldClear).toBe(true)

  await deactivate()
  if (previous === undefined) {
    delete process.env.ORCA_PRESENCE_LOG_FILE
  } else {
    process.env.ORCA_PRESENCE_LOG_FILE = previous
  }
  rmSync(dir, { recursive: true, force: true })
})

test('workspace.changed null context publishes minimal snapshot', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-wschanged-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  const { default: activate, deactivate } = await import('../src/main')
  const eventHandlers = new Map<string, (payload?: unknown) => Promise<void> | void>()
  const handlers = new Map<string, () => Promise<unknown>>()
  const hostLines: string[] = []
  const orca: OrcaHost = {
    log: (message) => void hostLines.push(message),
    commands: { register: (id, handler) => void handlers.set(id, handler) },
    events: { on: (event, handler) => void eventHandlers.set(event, handler) },
    host: {
      has: () => false,
      call: async (method) => (method === 'settings.get' ? { settings: { debugLogging: true } } : null)
    }
  }
  await activate(orca)
  await eventHandlers.get('agent.status.changed')?.({
    workspaceId: 'wt',
    paneKey: 'a',
    terminalId: 't1',
    state: 'working',
    receivedAt: Date.now()
  })
  await eventHandlers.get('workspace.changed')?.({ context: null })
  // Why: status() carries no agentCount; the minimal-refresh debug line does,
  // proving the table survived the null context and still published.
  expect(hostLines.some((line) => line.includes('refresh.minimal') && line.includes('agents=1'))).toBe(true)
  await handlers.get('presence.status')?.()
  await eventHandlers.get('workspace.changed')?.({
    context: { branch: 'main', displayName: 'orca', terminals: [{ id: 't1' }] }
  })
  await deactivate()
  if (previous === undefined) {
    delete process.env.ORCA_PRESENCE_LOG_FILE
  } else {
    process.env.ORCA_PRESENCE_LOG_FILE = previous
  }
  rmSync(dir, { recursive: true, force: true })
})

test('activate succeeds when host.has returns false for everything', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-nohas-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  const { default: activate, deactivate } = await import('../src/main')
  const calls: string[] = []
  const orca: OrcaHost = {
    log: () => {},
    commands: { register: () => {} },
    events: { on: () => {} },
    host: {
      has: () => false,
      call: async (method) => {
        calls.push(method)
        return method === 'settings.get' ? { settings: {} } : null
      }
    }
  }
  await activate(orca)
  expect(calls.includes('agents.list')).toBe(false)
  await deactivate()
  if (previous === undefined) {
    delete process.env.ORCA_PRESENCE_LOG_FILE
  } else {
    process.env.ORCA_PRESENCE_LOG_FILE = previous
  }
  rmSync(dir, { recursive: true, force: true })
})

test('settings.onDidChange re-reads, applies once, and rebinds on a new Application ID', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-ondidchange-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  const { default: activate, deactivate } = await import('../src/main')
  const hostLines: string[] = []
  const sets: string[] = []
  const handlers = new Map<string, () => Promise<unknown>>()
  let stored: Record<string, unknown> = {}
  let feed: ((e: { key: string }) => void) | null = null
  let disposed = false
  const orca: OrcaHost = {
    log: (message) => {
      hostLines.push(message)
    },
    commands: { register: (id, handler) => handlers.set(id, handler) },
    events: { on: () => {} },
    host: {
      has: () => false,
      call: async (method, args) => {
        if (method === 'settings.get') {
          return { settings: stored }
        }
        if (method === 'settings.set') {
          sets.push(String(args?.key))
          return null
        }
        return null
      }
    },
    settings: {
      onDidChange: (handler) => {
        feed = handler
        return {
          dispose: () => {
            disposed = true
          }
        }
      }
    }
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const detail = async () => ((await handlers.get('presence.status')?.()) as { detailLevel: string }).detailLevel
  await activate(orca)
  expect(feed).not.toBeNull()
  expect(await detail()).toBe('generic')

  stored = { detailLevel: 'full' }
  feed!({ key: 'detailLevel' })
  await wait(400)
  expect(await detail()).toBe('full')
  expect(hostLines.some((line) => line.includes('discord.app_id_rebind'))).toBe(false)

  stored = { detailLevel: 'full', applicationId: '1234567890123456789' }
  feed!({ key: 'applicationId' })
  feed!({ key: 'detailLevel' })
  await wait(400)
  expect(hostLines.filter((line) => line.includes('discord.app_id_rebind'))).toHaveLength(1)
  // Applying a host-originated change must not echo writes back to the host.
  expect(sets).toEqual([])

  // persist skips unchanged keys and never writes bridgeToken unless it changed.
  await handlers.get('presence.toggle-branch')?.()
  expect(sets).toEqual(['showBranch'])

  await deactivate()
  expect(disposed).toBe(true)
  if (previous === undefined) {
    delete process.env.ORCA_PRESENCE_LOG_FILE
  } else {
    process.env.ORCA_PRESENCE_LOG_FILE = previous
  }
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Activate against a fake host with a configurable keyring. Returns handles to
 * the calls the worker made so token routing can be asserted.
 */
async function activateWithSecrets(options: {
  protection: 'os-keyring' | 'unavailable'
  settings: Record<string, unknown>
  secret?: string | null
}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-token-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  const { default: activate, deactivate } = await import('../src/main')
  const handlers = new Map<string, (args?: Record<string, unknown>) => Promise<unknown>>()
  const notifications: string[] = []
  const settingsSets: Array<{ key: string; value: unknown }> = []
  const secretSets: Array<{ key: string; value: unknown }> = []
  const state = { stored: { ...options.settings }, secret: options.secret ?? null }
  let feed: ((e: { key: string }) => void) | null = null
  const has = (method: string) => method.startsWith('secrets.')
  const orca: OrcaHost = {
    log: () => {},
    commands: { register: (id, handler) => handlers.set(id, handler) },
    events: { on: () => {} },
    host: {
      has,
      call: async (method, args) => {
        switch (method) {
          case 'settings.get':
            return { settings: state.stored }
          case 'settings.set':
            settingsSets.push({ key: String(args?.key), value: args?.value })
            state.stored = { ...state.stored, [String(args?.key)]: args?.value }
            return null
          case 'secrets.protection':
            return { status: options.protection }
          case 'secrets.get':
            return { value: state.secret }
          case 'secrets.set':
            if (options.protection === 'unavailable') {
              throw new Error('secrets unavailable')
            }
            secretSets.push({ key: String(args?.key), value: args?.value })
            state.secret = String(args?.value)
            return null
          case 'notifications.show':
            notifications.push(String(args?.body ?? ''))
            return null
          default:
            return null
        }
      }
    },
    settings: {
      onDidChange: (handler) => {
        feed = handler
        return { dispose: () => {} }
      }
    }
  }
  await activate(orca)
  return {
    handlers,
    notifications,
    settingsSets,
    secretSets,
    state,
    feed: () => feed?.({ key: 'bridgeUrl' }),
    async finish() {
      await deactivate()
      if (previous === undefined) {
        delete process.env.ORCA_PRESENCE_LOG_FILE
      } else {
        process.env.ORCA_PRESENCE_LOG_FILE = previous
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('Show Status reports tokenStore=secrets and never prints the token', async () => {
  const run = await activateWithSecrets({
    protection: 'os-keyring',
    settings: {},
    secret: 'kept-secret-token'
  })
  const status = (await run.handlers.get('presence.status')?.()) as {
    bridgeTokenStore?: string
    warnings?: string[]
  }
  expect(status.bridgeTokenStore).toBe('secrets')
  expect(status.warnings ?? []).toEqual([])
  const body = run.notifications.at(-1) ?? ''
  expect(body.includes('tokenStore=secrets')).toBe(true)
  expect(JSON.stringify(status).includes('kept-secret-token')).toBe(false)
  expect(body.includes('kept-secret-token')).toBe(false)
  await run.finish()
})

test('Show Status warns and reports tokenStore=settings when secrets are unavailable', async () => {
  const run = await activateWithSecrets({
    protection: 'unavailable',
    settings: { bridgeToken: 'plain-token' }
  })
  const status = (await run.handlers.get('presence.status')?.()) as {
    bridgeTokenStore?: string
    warnings?: string[]
  }
  expect(status.bridgeTokenStore).toBe('settings')
  expect(status.warnings).toEqual(['secrets unavailable; bridge token stored in plugin settings'])
  const body = run.notifications.at(-1) ?? ''
  expect(body.includes('tokenStore=settings')).toBe(true)
  expect(body.includes('secrets unavailable')).toBe(true)
  expect(body.includes('plain-token')).toBe(false)
  // Nothing moved: the settings fallback keeps the token where it is.
  expect(run.settingsSets).toEqual([])
  await run.finish()
})

test('a settings-held token is moved into secrets once on activate', async () => {
  const run = await activateWithSecrets({
    protection: 'os-keyring',
    settings: { bridgeToken: 'legacy-token' }
  })
  expect(run.secretSets).toEqual([{ key: 'bridgeToken', value: 'legacy-token' }])
  expect(run.settingsSets).toEqual([{ key: 'bridgeToken', value: '' }])
  await run.finish()
})

test('configure writes bridgeToken to secrets and never through settings.set', async () => {
  const run = await activateWithSecrets({ protection: 'os-keyring', settings: {} })
  const result = (await run.handlers.get('presence.configure')?.({ bridgeToken: 'fresh-token' })) as {
    ok: boolean
    changed?: string[]
  }
  expect(result.ok).toBe(true)
  expect(result.changed).toEqual(['bridgeToken'])
  expect(run.secretSets).toEqual([{ key: 'bridgeToken', value: 'fresh-token' }])
  expect(run.settingsSets.some((entry) => entry.key === 'bridgeToken')).toBe(false)
  expect(run.notifications.join('\n').includes('fresh-token')).toBe(false)
  await run.finish()
})

test('a settings re-read does not wipe a secrets-held token', async () => {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      seen.push(request.headers.get('authorization') ?? '')
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }
  })
  try {
    const run = await activateWithSecrets({
      protection: 'os-keyring',
      settings: { bridgeEnabled: true, bridgeUrl: `http://127.0.0.1:${server.port}` },
      secret: 'held-token'
    })
    run.feed()
    await new Promise((resolve) => setTimeout(resolve, 400))
    seen.length = 0
    await run.handlers.get('presence.status')?.()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((header) => header === 'Bearer held-token')).toBe(true)
    await run.finish()
  } finally {
    await server.stop(true)
  }
})

/**
 * Activate against a fake host that offers `panels`. Captures the registered
 * panel handlers, `panels.post` calls, and `settings.set` writes.
 */
async function activateWithPanels(settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-panel-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  const { default: activate, deactivate } = await import('../src/main')
  const panelHandlers = new Map<string, (input: unknown) => unknown>()
  const eventHandlers = new Map<string, (payload?: unknown) => Promise<void> | void>()
  const posts: Array<{ name: string; payload: unknown }> = []
  const sets: Array<{ key: string; value: unknown }> = []
  const state = { stored: { ...settings } }
  const orca: OrcaHost = {
    log: () => {},
    commands: { register: () => {} },
    events: { on: (event, handler) => void eventHandlers.set(event, handler) },
    host: {
      has: () => false,
      call: async (method, args) => {
        if (method === 'settings.get') {
          return { settings: state.stored }
        }
        if (method === 'settings.set') {
          sets.push({ key: String(args?.key), value: args?.value })
          state.stored = { ...state.stored, [String(args?.key)]: args?.value }
        }
        return null
      }
    },
    panels: {
      handle: (name, fn) => {
        panelHandlers.set(name, fn)
        return { dispose: () => void panelHandlers.delete(name) }
      },
      post: (name, payload) => void posts.push({ name, payload })
    }
  }
  await activate(orca)
  const snapshot = async () => (await panelHandlers.get('presence.snapshot')?.(undefined)) as PresencePanelSnapshot
  const run = async (command: unknown) =>
    (await panelHandlers.get('presence.run')?.({ command })) as { ok: boolean; message?: string }
  return {
    panelHandlers,
    eventHandlers,
    posts,
    sets,
    snapshot,
    run,
    async finish() {
      await deactivate()
      if (previous === undefined) {
        delete process.env.ORCA_PRESENCE_LOG_FILE
      } else {
        process.env.ORCA_PRESENCE_LOG_FILE = previous
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('presence.snapshot handler returns the plugin version and never the bridge token', async () => {
  const run = await activateWithPanels({ bridgeEnabled: true, bridgeToken: 'panel-secret-token' })
  const snapshot = await run.snapshot()
  expect(snapshot.version).toBe(PLUGIN_VERSION)
  expect(snapshotLeaksSecrets(snapshot, ['panel-secret-token'])).toBe(false)
  expect(JSON.stringify(snapshot).includes('bridgeToken')).toBe(false)
  await run.finish()
})

test('presence.run presence.toggle flips enabled and reports ok', async () => {
  const run = await activateWithPanels()
  expect((await run.snapshot()).fields.enabled).toBe(true)
  const result = await run.run('presence.toggle')
  expect(result.ok).toBe(true)
  expect((await run.snapshot()).fields.enabled).toBe(false)
  expect(run.sets).toEqual([{ key: 'enabled', value: false }])
  await run.finish()
})

test('presence.run accepts every panel command id', async () => {
  const run = await activateWithPanels()
  for (const command of [
    'presence.toggle',
    'presence.reload',
    'presence.clear',
    'presence.status',
    'presence.detail-level'
  ]) {
    expect((await run.run(command)).ok).toBe(true)
  }
  await run.finish()
})

test('presence.run rejects other commands with code invalid_params', async () => {
  const run = await activateWithPanels()
  for (const command of ['presence.configure', 'presence.toggle-branch', '', 42, undefined]) {
    await expect(run.run(command)).rejects.toMatchObject({ code: 'invalid_params' })
  }
  await expect(
    Promise.resolve().then(() => run.panelHandlers.get('presence.run')?.(null))
  ).rejects.toMatchObject({ code: 'invalid_params' })
  await run.finish()
})

test('an agent event posts presence.snapshot to the panel within the debounce window', async () => {
  const run = await activateWithPanels()
  run.posts.length = 0
  await run.eventHandlers.get('agent.status.changed')?.({
    workspaceId: 'wt',
    paneKey: 'a',
    terminalId: 't1',
    state: 'working',
    receivedAt: Date.now()
  })
  await new Promise((resolve) => setTimeout(resolve, 2_300))
  const post = run.posts.find((entry) => entry.name === 'presence.snapshot')
  expect(post).toBeDefined()
  expect((post?.payload as PresencePanelSnapshot).version).toBe(PLUGIN_VERSION)
  await run.finish()
})

test('persist never sends a null value for a declared settings key', async () => {
  const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')) as {
    contributes: { settings: Array<{ key: string }> }
  }
  const declared = new Set(manifest.contributes.settings.map((setting) => setting.key))
  const run = await activateWithPanels({ machineLabel: 'Desk' })
  await run.run('presence.toggle')
  await run.run('presence.detail-level')
  for (const entry of run.sets) {
    expect(declared.has(entry.key)).toBe(true)
    expect(entry.value).not.toBeNull()
    expect(entry.value).not.toBeUndefined()
  }
  expect(toSettingsValue(null)).toBe('')
  expect(toSettingsValue('Desk')).toBe('Desk')
  expect(toSettingsValue(false)).toBe(false)
  await run.finish()
})

test('panel/index.html uses the stock frame API with no network or legacy bridge', () => {
  const html = readFileSync(join(root, 'panel/index.html'), 'utf8')
  expect(html.includes('orca-panel-action')).toBe(false)
  expect(/<script[^>]*\ssrc=/.test(html)).toBe(false)
  expect(html.includes('http')).toBe(false)
  expect(html.includes('presence-snapshot')).toBe(false)
  expect(html.includes('plugin-version')).toBe(false)
  expect(html.includes('window.orca')).toBe(true)
  // Why: window.orca is a read-only global in the frame. Running the inline
  // script as a classic script against such a global catches a top-level
  // `var orca`, which assigns window.orca and throws in strict mode.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, textContent: '' })
  const sandbox = vm.createContext({
    document: { getElementById: el, querySelectorAll: () => [] },
    navigator: {}
  })
  vm.runInContext('Object.defineProperty(globalThis, "orca", { value: Object.freeze({}), writable: false }); globalThis.window = globalThis', sandbox)
  expect(() => vm.runInContext(script, sandbox)).not.toThrow()
  expect(html.includes('plugin.request')).toBe(true)
  expect(html.includes('presence.run')).toBe(true)
  expect(html.includes('Open this panel in the Orca desktop app to see live status.')).toBe(true)
  expect(html.includes('--orca-background')).toBe(true)
})

test('formatStatusTransmitting includes lastActivity and truncates long JSON', () => {
  expect(formatStatusTransmitting(null)).toBe('transmitting=null')
  expect(formatStatusTransmitting({ details: 'Working in Orca' })).toBe(
    'transmitting={"details":"Working in Orca"}'
  )
  const long = formatStatusTransmitting({ details: 'x'.repeat(400) })
  expect(long.startsWith('transmitting=')).toBe(true)
  expect(long.endsWith('…')).toBe(true)
  expect(long.length <= 200).toBe(true)
})

test('shipped dist entry is Node-compatible ESM with the same exports', async () => {
  const shipped = readFileSync(join(root, 'dist/main.js'), 'utf8')
  expect(shipped.includes('Bun.file')).toBe(false)
  expect(shipped.includes('Bun.spawn')).toBe(false)
  expect(shipped.includes('from "node:net"') || shipped.includes("from 'node:net'")).toBe(true)
  expect(shipped.includes('presence.reload')).toBe(true)
  expect(shipped.includes('presence.clear')).toBe(true)
  expect(shipped.includes('presence.configure')).toBe(true)
  expect(shipped.includes('discord.app_id_invalid')).toBe(true)
  expect(shipped.includes('panel-html')).toBe(false)
  expect(shipped.includes('presence.snapshot')).toBe(true)
  expect(shipped.includes('presence.run')).toBe(true)
  const entry = new URL('../dist/main.js', import.meta.url).href
  const mod = (await import(entry)) as { default: unknown; deactivate: unknown }
  expect(typeof mod.default).toBe('function')
  expect(typeof mod.deactivate).toBe('function')
})
