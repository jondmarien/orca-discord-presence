import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { OPCODE, encodeFrame, createFrameDecoder } from '../src/discord-frame.mjs'
import { createDiscordClient } from '../src/discord-client.mjs'

function fakeSocketPath() {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\orca-presence-test-${process.pid}-${Math.floor(performance.now())}`
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-presence-'))
  return { path: path.join(dir, 'sock'), dir }
}

function startFakeDiscord(socketPath, { onCommand }) {
  const server = net.createServer((socket) => {
    const decoder = createFrameDecoder((opcode, data) => {
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
        onCommand(data)
        socket.write(encodeFrame(OPCODE.FRAME, { cmd: data.cmd, nonce: data.nonce, data: {} }))
      }
    })
    socket.on('data', (chunk) => decoder.push(chunk))
  })
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)))
}

test('connects, handshakes, and sends SET_ACTIVITY with a pid and nonce', async () => {
  const target = fakeSocketPath()
  const socketPath = typeof target === 'string' ? target : target.path
  const commands = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: (data) => commands.push(data)
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath]
  })

  await client.connect()
  await client.setActivity({ details: 'orca', state: 'working' })

  assert.equal(commands.length, 1)
  assert.equal(commands[0].cmd, 'SET_ACTIVITY')
  assert.equal(typeof commands[0].nonce, 'string')
  assert.equal(commands[0].args.pid, process.pid)
  assert.equal(commands[0].args.activity.details, 'orca')

  await client.close()
  server.close()
  if (typeof target !== 'string') {
    rmSync(target.dir, { recursive: true, force: true })
  }
})

test('connect rejects when no candidate socket accepts', async () => {
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => ['/nonexistent/orca-presence-missing-socket']
  })
  await assert.rejects(() => client.connect(), /no discord ipc socket/i)
})

test('clearActivity sends a null activity', async () => {
  const target = fakeSocketPath()
  const socketPath = typeof target === 'string' ? target : target.path
  const commands = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: (data) => commands.push(data)
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath]
  })
  await client.connect()
  await client.clearActivity()
  assert.equal(commands[0].args.activity, null)
  await client.close()
  server.close()
  if (typeof target !== 'string') {
    rmSync(target.dir, { recursive: true, force: true })
  }
})

test('a dropped socket marks the client disconnected and fires onClose once', async () => {
  const target = fakeSocketPath()
  const socketPath = typeof target === 'string' ? target : target.path
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
  assert.equal(client.isConnected(), false)
  assert.equal(closes, 1)
  if (typeof target !== 'string') {
    rmSync(target.dir, { recursive: true, force: true })
  }
})
