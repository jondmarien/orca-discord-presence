import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parseCompanionConfig } from '../companion/config'
import {
  startCompanionServer,
  tokensEqual,
  type CompanionDiscordClient
} from '../companion/http'
import { createDiscordClient } from '../src/discord/client'
import { createFrameDecoder, encodeFrame, OPCODE } from '../src/discord/ipc'

type FakeTarget = string | { path: string; dir: string }

function fakeSocketPath(): FakeTarget {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\orca-presence-companion-${process.pid}-${Math.floor(performance.now())}`
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-companion-'))
  return { path: path.join(dir, 'sock'), dir }
}

function targetPath(target: FakeTarget): string {
  return typeof target === 'string' ? target : target.path
}

function cleanupTarget(target: FakeTarget) {
  if (typeof target !== 'string') {
    rmSync(target.dir, { recursive: true, force: true })
  }
}

function startFakeDiscord(socketPath: string, { onCommand }: { onCommand: (data: Record<string, unknown>) => void }) {
  const server = net.createServer((socket) => {
    const decoder = createFrameDecoder((opcode, data) => {
      const payload = data as Record<string, unknown>
      if (opcode === OPCODE.HANDSHAKE) {
        socket.write(encodeFrame(OPCODE.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }))
        return
      }
      if (opcode === OPCODE.FRAME) {
        onCommand(payload)
        socket.write(encodeFrame(OPCODE.FRAME, { cmd: payload.cmd, nonce: payload.nonce, data: {} }))
      }
    })
    socket.on('data', (chunk) => decoder.push(chunk))
  })
  return new Promise<net.Server>((resolve) => server.listen(socketPath, () => resolve(server)))
}

function fakeClient(): CompanionDiscordClient & { activities: Array<object | null> } {
  const activities: Array<object | null> = []
  return {
    activities,
    connect: async () => {},
    isConnected: () => true,
    setActivity: async (activity) => {
      activities.push(activity)
    },
    clearActivity: async () => {
      activities.push(null)
    },
    close: async () => {}
  }
}

async function listen(overrides: {
  token?: string
  client?: CompanionDiscordClient
  candidates?: () => string[]
}) {
  const config = parseCompanionConfig({
    ORCA_PRESENCE_BIND: '127.0.0.1',
    ORCA_PRESENCE_PORT: '0',
    ...(overrides.token ? { ORCA_PRESENCE_BRIDGE_TOKEN: overrides.token } : {})
  })
  return startCompanionServer({
    config,
    client: overrides.client,
    candidates: overrides.candidates
  })
}

test('tokensEqual is length-safe', () => {
  expect(tokensEqual('abc', 'abc')).toBe(true)
  expect(tokensEqual('abc', 'abd')).toBe(false)
  expect(tokensEqual('abc', 'ab')).toBe(false)
})

test('POST /activity applies SET_ACTIVITY and DELETE clears', async () => {
  const client = fakeClient()
  const server = await listen({ client })
  const posted = await fetch(`${server.url}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ details: 'Working in Orca' })
  })
  expect(posted.status).toBe(204)
  expect(client.activities).toEqual([{ details: 'Working in Orca' }])
  const cleared = await fetch(`${server.url}/activity`, { method: 'DELETE' })
  expect(cleared.status).toBe(204)
  expect(client.activities.at(-1)).toBeNull()
  const health = await fetch(`${server.url}/health`)
  expect(await health.json()).toEqual({ ok: true, discordConnected: true })
  await server.close()
})

test('a configured token is required even on loopback', async () => {
  const client = fakeClient()
  const server = await listen({ client, token: 'only-this' })
  const denied = await fetch(`${server.url}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ details: 'x' })
  })
  expect(denied.status).toBe(401)
  const allowed = await fetch(`${server.url}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer only-this' },
    body: JSON.stringify({ details: 'x' })
  })
  expect(allowed.status).toBe(204)
  await server.close()
})

test('POST /activity through the real IPC client (same path as the plugin)', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  const commands: Record<string, unknown>[] = []
  const discord = await startFakeDiscord(socketPath, {
    onCommand: (data) => commands.push(data)
  })
  const server = await listen({
    client: createDiscordClient({
      clientId: '123456789012345678',
      candidates: () => [socketPath]
    })
  })
  const posted = await fetch(`${server.url}/activity`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ details: 'bridged' })
  })
  expect(posted.status).toBe(204)
  expect(commands[0]?.cmd).toBe('SET_ACTIVITY')
  const args = commands[0]?.args as { activity: { details: string } }
  expect(args.activity.details).toBe('bridged')
  await server.close()
  discord.close()
  cleanupTarget(target)
})
