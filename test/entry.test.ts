import { afterAll, beforeAll, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DISCORD_IPC_ENV } from '../src/discord/ipc'
import { formatStatusTransmitting, type OrcaHost } from '../src/main'
import { LOG_DIR_NAME, LOG_PLUGIN_ID } from '../src/presence/log'
import { extractPanelSnapshot } from '../src/presence/panel-html'
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
  const panelFile = join(dir, 'index.html')
  copyFileSync(join(root, 'panel/index.html'), panelFile)
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  const previousPanel = process.env.ORCA_PRESENCE_PANEL_HTML
  process.env.ORCA_PRESENCE_LOG_FILE = logFile
  process.env.ORCA_PRESENCE_PANEL_HTML = panelFile
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
  const embedded = extractPanelSnapshot(readFileSync(panelFile, 'utf8')) as {
    version: string
    status: { detailLevel: string }
    logs: string[]
  }
  expect(embedded.version).toBe(PLUGIN_VERSION)
  expect(embedded.status.detailLevel).toBe('generic')
  expect(embedded.logs.some((line) => line.includes('activate'))).toBe(true)
  expect(JSON.stringify(embedded).includes('bridgeToken')).toBe(false)
  await deactivate()
  await deactivate()
  if (previous === undefined) {
    delete process.env.ORCA_PRESENCE_LOG_FILE
  } else {
    process.env.ORCA_PRESENCE_LOG_FILE = previous
  }
  if (previousPanel === undefined) {
    delete process.env.ORCA_PRESENCE_PANEL_HTML
  } else {
    process.env.ORCA_PRESENCE_PANEL_HTML = previousPanel
  }
  rmSync(dir, { recursive: true, force: true })
})

test('an invalid persisted Application ID is logged and toasted', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-appid-'))
  const logFile = join(dir, 'plugin.log')
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  const previousSkip = process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  process.env.ORCA_PRESENCE_LOG_FILE = logFile
  process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = '1'
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
  if (previousSkip === undefined) {
    delete process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  } else {
    process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = previousSkip
  }
  rmSync(dir, { recursive: true, force: true })
})

test('configure fails fast on a junk Application ID and accepts two paneKeys', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-configure-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  const previousSkip = process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = '1'
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
  if (previousSkip === undefined) {
    delete process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  } else {
    process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = previousSkip
  }
  rmSync(dir, { recursive: true, force: true })
})

test('workspace.changed null context publishes minimal snapshot', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-wschanged-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  const previousSkip = process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = '1'
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
  if (previousSkip === undefined) {
    delete process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  } else {
    process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = previousSkip
  }
  rmSync(dir, { recursive: true, force: true })
})

test('activate succeeds when host.has returns false for everything', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-nohas-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  const previousSkip = process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = '1'
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
  if (previousSkip === undefined) {
    delete process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  } else {
    process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = previousSkip
  }
  rmSync(dir, { recursive: true, force: true })
})

test('settings.onDidChange re-reads, applies once, and rebinds on a new Application ID', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'orca-presence-ondidchange-'))
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  const previousSkip = process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  process.env.ORCA_PRESENCE_LOG_FILE = join(dir, 'plugin.log')
  process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = '1'
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
  if (previousSkip === undefined) {
    delete process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE
  } else {
    process.env.ORCA_PRESENCE_SKIP_PANEL_WRITE = previousSkip
  }
  rmSync(dir, { recursive: true, force: true })
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
  expect(shipped.includes('presence-snapshot') || shipped.includes('panel.snapshot')).toBe(true)
  const entry = new URL('../dist/main.js', import.meta.url).href
  const mod = (await import(entry)) as { default: unknown; deactivate: unknown }
  expect(typeof mod.default).toBe('function')
  expect(typeof mod.deactivate).toBe('function')
})
