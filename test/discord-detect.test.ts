/**
 * Discord client detection: path-to-family mapping, liveness probing,
 * choosing a client by id, and the path-free summary the panel receives.
 *
 * Hermetic: candidates and the connect function are injected; no real socket
 * is ever dialled.
 *
 * @author Jonathan Marien
 * @date 2026-11-04
 */

import { expect, test } from 'bun:test'
import {
  classifyClientPath,
  detectDiscordClients,
  resolveClientCandidates,
  summarizeClients,
  type DetectedClient
} from '../src/discord/detect'

const VESKTOP = '/run/user/1000/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-0'
const FLATPAK = '/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'
const SNAP = '/run/user/1000/snap.discord/discord-ipc-0'
const PLAIN0 = '/run/user/1000/discord-ipc-0'
const PLAIN1 = '/run/user/1000/discord-ipc-1'
const PIPE0 = '\\\\?\\pipe\\discord-ipc-0'
const PIPE2 = '\\\\?\\pipe\\discord-ipc-2'

const alive = (live: string[]) => async (path: string) => live.includes(path)

test('classifies each path kind into a family, stable id and label', () => {
  expect(classifyClientPath(VESKTOP)).toEqual({ id: 'vesktop:0', label: 'Vesktop' })
  expect(classifyClientPath(FLATPAK)).toEqual({ id: 'discord-flatpak:0', label: 'Discord (Flatpak)' })
  expect(classifyClientPath(SNAP)).toEqual({ id: 'discord-snap:0', label: 'Discord (Snap)' })
  expect(classifyClientPath(PLAIN1)).toEqual({ id: 'discord:1', label: 'Discord' })
  expect(classifyClientPath(PIPE0)).toEqual({ id: 'pipe:0', label: 'Discord client #1' })
  expect(classifyClientPath(PIPE2)).toEqual({ id: 'pipe:2', label: 'Discord client #3' })
})

test('detect returns only candidates whose connect succeeds, paths kept', async () => {
  const found = await detectDiscordClients({
    candidates: [VESKTOP, FLATPAK, SNAP, PLAIN0],
    connect: alive([VESKTOP, PLAIN0])
  })
  expect(found).toEqual([
    { id: 'vesktop:0', label: 'Vesktop', path: VESKTOP },
    { id: 'discord:0', label: 'Discord', path: PLAIN0 }
  ])
})

test('two live clients of one family get an index in the label', async () => {
  const found = await detectDiscordClients({
    candidates: [PLAIN0, PLAIN1, VESKTOP],
    connect: alive([PLAIN0, PLAIN1, VESKTOP])
  })
  expect(found.map((c) => c.label)).toEqual(['Discord (1)', 'Discord (2)', 'Vesktop'])
  expect(found.map((c) => c.id)).toEqual(['discord:0', 'discord:1', 'vesktop:0'])
})

test('windows pipes are labelled by number', async () => {
  const found = await detectDiscordClients({ candidates: [PIPE0, PIPE2], connect: alive([PIPE0, PIPE2]) })
  expect(found.map((c) => c.label)).toEqual(['Discord client #1', 'Discord client #3'])
})

test('duplicate paths probe once and list once', async () => {
  const probed: string[] = []
  const found = await detectDiscordClients({
    candidates: [PLAIN0, PLAIN0],
    connect: async (path) => {
      probed.push(path)
      return true
    }
  })
  expect(probed).toEqual([PLAIN0])
  expect(found).toHaveLength(1)
})

test('probes at most 10 sockets at a time and passes the timeout', async () => {
  const candidates = Array.from({ length: 40 }, (_, i) => `/x/${i}/discord-ipc-0`)
  let inFlight = 0
  let peak = 0
  const timeouts = new Set<number>()
  await detectDiscordClients({
    candidates,
    timeoutMs: 123,
    connect: async (_path, timeoutMs) => {
      timeouts.add(timeoutMs)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return false
    }
  })
  expect(peak).toBeLessThanOrEqual(10)
  expect(peak).toBeGreaterThan(1)
  expect([...timeouts]).toEqual([123])
})

test('never throws: a throwing connect or candidates yields []', async () => {
  const boom = async () => {
    throw new Error('boom')
  }
  expect(await detectDiscordClients({ candidates: [PLAIN0], connect: boom })).toEqual([])
  expect(
    await detectDiscordClients({
      candidates: [PLAIN0],
      connect: alive([PLAIN0])
    })
  ).toHaveLength(1)
  expect(
    await detectDiscordClients({
      candidates: () => {
        throw new Error('no candidates')
      }
    } as never)
  ).toEqual([])
})

const detected: DetectedClient[] = [
  { id: 'vesktop:0', label: 'Vesktop', path: VESKTOP },
  { id: 'discord:0', label: 'Discord', path: PLAIN0 }
]
const auto = [PLAIN0, VESKTOP, SNAP]

test('auto keeps the full auto order and is not a fallback', () => {
  expect(resolveClientCandidates('auto', detected, auto)).toEqual({ candidates: auto, fallback: false })
})

test('a chosen detected id connects only to its own path', () => {
  expect(resolveClientCandidates('vesktop:0', detected, auto)).toEqual({
    candidates: [VESKTOP],
    fallback: false
  })
})

test('a chosen id that is not detected falls back to auto order with clientFallback', () => {
  expect(resolveClientCandidates('discord-snap:0', detected, auto)).toEqual({
    candidates: auto,
    fallback: true
  })
})

test('summary names the connected client and never carries a path', () => {
  const summary = summarizeClients({ connectedPath: VESKTOP, choice: 'auto', detected })
  expect(summary.client).toEqual({ id: 'vesktop:0', label: 'Vesktop' })
  expect(summary.clientFallback).toBe(false)
  expect(summary.clients).toEqual([
    { id: 'vesktop:0', label: 'Vesktop' },
    { id: 'discord:0', label: 'Discord' }
  ])
  for (const entry of summary.clients) expect('path' in entry).toBe(false)
  const json = JSON.stringify(summary)
  expect(json.includes('/run/user')).toBe(false)
})

test('summary: not connected is null, stale undetected choice sets fallback', () => {
  const summary = summarizeClients({ connectedPath: null, choice: 'discord-snap:0', detected })
  expect(summary.client).toBeNull()
  expect(summary.clientFallback).toBe(true)
  // A connected path missing from the last scan is still named, by family.
  expect(summarizeClients({ connectedPath: SNAP, choice: 'auto', detected }).client).toEqual({
    id: 'discord-snap:0',
    label: 'Discord (Snap)'
  })
})

test('same socket index under /run/user and /tmp stays two distinct entries', async () => {
  const tmp = '/tmp/discord-ipc-0'
  expect(classifyClientPath(PLAIN0).id).toBe('discord:0')
  expect(classifyClientPath(tmp).id).toBe('discord:tmp:0')
  const found = await detectDiscordClients({
    candidates: [PLAIN0, tmp],
    connect: alive([PLAIN0, tmp]),
    realpath: (path) => path
  })
  expect(found.map((c) => c.id)).toEqual(['discord:0', 'discord:tmp:0'])
  expect(found.map((c) => c.label)).toEqual(['Discord (1)', 'Discord (2)'])
})

test('two paths with the same real path collapse into one entry', async () => {
  const tmp = '/tmp/discord-ipc-0'
  const found = await detectDiscordClients({
    candidates: [PLAIN0, tmp],
    connect: alive([PLAIN0, tmp]),
    realpath: () => '/run/user/1000/discord-ipc-0'
  })
  expect(found.map((c) => c.id)).toEqual(['discord:0'])
  expect(found[0]?.label).toBe('Discord')
})
