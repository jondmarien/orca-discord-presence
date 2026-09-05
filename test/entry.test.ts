import { expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatStatusTransmitting, type OrcaHost } from '../src/main'
import { extractPanelSnapshot } from '../src/presence/panel-html'
import { PLUGIN_VERSION } from '../src/version'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('manifest identity is chron0.discord-presence', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')) as {
    id: string
    publisher: string
    version: string
    engines: { orca: string }
    contributes: {
      panels: Array<{ id: string; title: string; icon?: string; entry: string }>
      commands: Array<{ id: string }>
      events: Array<{ on: string }>
    }
    capabilities: Array<{ kind: string }>
  }
  expect(manifest.publisher).toBe('chron0')
  expect(manifest.id).toBe('discord-presence')
  expect(`${manifest.publisher}.${manifest.id}`).toBe('chron0.discord-presence')
  expect(manifest.version).toBe(PLUGIN_VERSION)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  expect(pkg.version).toBe(PLUGIN_VERSION)
  expect(manifest.id.includes('prescence')).toBe(false)
  expect(manifest.contributes.panels).toEqual([
    { id: 'presence', title: 'Discord Presence', icon: 'settings', entry: 'panel/index.html' }
  ])
  expect(manifest.contributes.commands.some((command) => command.id === 'presence.reload')).toBe(true)
  expect(manifest.capabilities.some((cap) => cap.kind === 'terminal:send')).toBe(false)
  expect(manifest.capabilities.some((cap) => cap.kind === 'ui:focus')).toBe(true)
  expect(manifest.capabilities.some((cap) => cap.kind === 'sidecar')).toBe(true)
  expect(manifest.contributes.events.some((event) => event.on === 'ui.focus.changed')).toBe(true)
  expect(manifest.engines).toEqual({ orca: '>=1.4.0' })
  expect(readFileSync(join(root, manifest.contributes.panels[0]!.entry), 'utf8').includes('orca-panel-action')).toBe(
    true
  )
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
  const storageKeys: string[] = []
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
      call: async (method, args) => {
        if (method === 'settings.get') {
          return { settings: {} }
        }
        if (method === 'notifications.show') {
          notifications.push(String(args?.body ?? ''))
          return null
        }
        if (method === 'storage.set') {
          storageKeys.push(String(args?.key ?? ''))
          return { ok: true }
        }
        if (method === 'sidecar.resolvePlacement') {
          return {
            mailboxAvailable: true,
            companionStillValid: true,
            lastPublishedAt: null
          }
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
  expect(events).toEqual([
    'agent.status.changed',
    'worktree.created',
    'worktree.removed',
    'ui.focus.changed'
  ])
  expect(hostLines.some((line) => line.includes('activate') && line.includes('chron0.discord-presence'))).toBe(
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
  expect(storageKeys.includes('diagnostics.snapshot')).toBe(true)
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
    worktreeId: 'wt',
    paneKey: 'a',
    state: 'working',
    receivedAt: Date.now()
  })
  await agent?.({
    worktreeId: 'wt',
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
