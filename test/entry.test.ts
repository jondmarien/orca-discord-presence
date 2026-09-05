import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaHost } from '../src/main'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('manifest identity is chron0.discord-presence', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')) as {
    id: string
    publisher: string
  }
  expect(manifest.publisher).toBe('chron0')
  expect(manifest.id).toBe('discord-presence')
  expect(`${manifest.publisher}.${manifest.id}`).toBe('chron0.discord-presence')
  expect(manifest.id.includes('prescence')).toBe(false)
})

test('activate and deactivate exports are functions', async () => {
  const mod = await import('../src/main')
  expect(typeof mod.default).toBe('function')
  expect(typeof mod.deactivate).toBe('function')
})

test('activate registers commands and events; deactivate is safe to call', async () => {
  const { default: activate, deactivate } = await import('../src/main')
  const commands: string[] = []
  const events: string[] = []
  const orca: OrcaHost = {
    log: () => {},
    commands: {
      register: (id) => {
        commands.push(id)
      }
    },
    events: {
      on: (event) => {
        events.push(event)
      }
    },
    host: {
      call: async (method) => {
        if (method === 'settings.get') {
          return { settings: {} }
        }
        // No workspace context: refresh returns before opening Discord IPC.
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
    'presence.status'
  ])
  expect(events).toEqual(['agent.status.changed', 'worktree.created', 'worktree.removed'])
  await deactivate()
})

test('shipped dist entry is Node-compatible ESM with the same exports', async () => {
  const shipped = readFileSync(join(root, 'dist/main.js'), 'utf8')
  expect(shipped.includes('Bun.file')).toBe(false)
  expect(shipped.includes('Bun.spawn')).toBe(false)
  expect(shipped.includes('from "node:net"') || shipped.includes("from 'node:net'")).toBe(true)
  const entry = new URL('../dist/main.js', import.meta.url).href
  const mod = (await import(entry)) as { default: unknown; deactivate: unknown }
  expect(typeof mod.default).toBe('function')
  expect(typeof mod.deactivate).toBe('function')
})
