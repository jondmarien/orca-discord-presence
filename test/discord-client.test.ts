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

function startFakeDiscord(socketPath: string, { onCommand }: { onCommand: (data: Record<string, unknown>) => void }) {
  const server = net.createServer((socket) => {
    const decoder = createFrameDecoder((opcode, data) => {
      const payload = data as Record<string, unknown>
      if (opcode === OPCODE.HANDSHAKE) {
        socket.write(
          encodeFrame(OPCODE.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } })
        )
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
