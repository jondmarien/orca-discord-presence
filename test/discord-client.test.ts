import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createDiscordClient } from '../src/discord/client'
import { createFrameDecoder, encodeFrame, OPCODE } from '../src/discord/ipc'

type FakeTarget = string | { path: string; dir: string }

function fakeSocketPath(): FakeTarget {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\orca-presence-test-${process.pid}-${Math.floor(performance.now())}`
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-presence-'))
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

function startFakeDiscord(
  socketPath: string,
  {
    onCommand,
    handshake
  }: {
    onCommand: (data: Record<string, unknown>) => void
    handshake?: (connection: number) => Record<string, unknown>
  }
) {
  let connections = 0
  const server = net.createServer((socket) => {
    const connection = ++connections
    const decoder = createFrameDecoder((opcode, data) => {
      const payload = data as Record<string, unknown>
      if (opcode === OPCODE.HANDSHAKE) {
        const body = handshake
          ? handshake(connection)
          : { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }
        socket.write(encodeFrame(OPCODE.FRAME, body))
        return
      }
      if (opcode === OPCODE.PING) {
        socket.write(encodeFrame(OPCODE.PONG, data))
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

test('connects, handshakes, and sends SET_ACTIVITY with a pid and nonce', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  const commands: Record<string, unknown>[] = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: (data) => commands.push(data)
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath]
  })

  await client.connect()
  await client.setActivity({ details: 'orca', state: 'working' })

  expect(commands.length).toBe(1)
  expect(commands[0]?.cmd).toBe('SET_ACTIVITY')
  expect(typeof commands[0]?.nonce).toBe('string')
  const args = commands[0]?.args as { pid: number; activity: { details: string } }
  expect(args.pid).toBe(process.pid)
  expect(args.activity.details).toBe('orca')

  await client.close()
  server.close()
  cleanupTarget(target)
})

test('connect rejects when no candidate socket accepts', async () => {
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => ['/nonexistent/orca-presence-missing-socket']
  })
  await expect(client.connect()).rejects.toThrow(/no discord ipc socket/i)
})

test('clearActivity sends a null activity', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  const commands: Record<string, unknown>[] = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: (data) => commands.push(data)
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath]
  })
  await client.connect()
  await client.clearActivity()
  const args = commands[0]?.args as { activity: unknown }
  expect(args.activity).toBeNull()
  await client.close()
  server.close()
  cleanupTarget(target)
})

test('close sends SET_ACTIVITY null before tearing down the socket', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  const commands: Record<string, unknown>[] = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: (data) => commands.push(data)
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath]
  })
  await client.connect()
  await client.setActivity({ details: 'orca' })
  await client.close()
  expect(commands.length).toBe(2)
  expect((commands[1]?.args as { activity: unknown }).activity).toBeNull()
  server.close()
  cleanupTarget(target)
})

test('close is idempotent', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  const server = await startFakeDiscord(socketPath, { onCommand: () => {} })
  let closes = 0
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath],
    onClose: () => {
      closes++
    }
  })
  await client.connect()
  await client.close()
  await client.close()
  expect(closes).toBe(1)
  expect(client.isConnected()).toBe(false)
  server.close()
  cleanupTarget(target)
})

test('READY with null data is retryable and a later READY succeeds', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  const sleeps: number[] = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: () => {},
    handshake: (connection) =>
      connection === 1
        ? { cmd: 'DISPATCH', evt: 'READY', data: null }
        : { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath],
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })
  await client.connect()
  expect(client.isConnected()).toBe(true)
  expect(sleeps).toEqual([3_000])
  await client.close()
  server.close()
  cleanupTarget(target)
})

test('handshake timeout retries then succeeds', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  const sleeps: number[] = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: () => {},
    handshake: (connection) => {
      if (connection === 1) {
        return { cmd: 'DISPATCH', evt: 'NOT_READY' }
      }
      return { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }
    }
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath],
    handshakeTimeoutMs: 40,
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })
  await client.connect()
  expect(client.isConnected()).toBe(true)
  expect(sleeps).toEqual([3_000])
  await client.close()
  server.close()
  cleanupTarget(target)
})

test('an invalid Application ID fails fast without opening a socket', async () => {
  let candidateCalls = 0
  const client = createDiscordClient({
    clientId: 'not-a-snowflake',
    candidates: () => {
      candidateCalls++
      return ['/nonexistent/orca-presence-missing-socket']
    }
  })
  await expect(client.connect()).rejects.toThrow(/application id is invalid/i)
  expect(candidateCalls).toBe(0)
})

test('a 404 handshake error is fatal and is not retried', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  let handshakes = 0
  const server = await startFakeDiscord(socketPath, {
    onCommand: () => {},
    handshake: () => {
      handshakes++
      return { evt: 'ERROR', data: { message: '404 Not Found' } }
    }
  })
  const sleeps: number[] = []
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath],
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })
  await expect(client.connect()).rejects.toThrow(/404/)
  expect(handshakes).toBe(1)
  expect(sleeps).toEqual([])
  server.close()
  cleanupTarget(target)
})

test('a dropped socket marks the client disconnected and fires onClose once', async () => {
  const target = fakeSocketPath()
  const socketPath = targetPath(target)
  const server = await startFakeDiscord(socketPath, { onCommand: () => {} })
  let closes = 0
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath],
    onClose: () => {
      closes++
    }
  })
  await client.connect()
  server.close()
  client.destroySocketForTest()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(client.isConnected()).toBe(false)
  expect(closes).toBe(1)
  cleanupTarget(target)
})
