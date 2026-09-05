import { randomUUID } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import { createFrameDecoder, discordIpcCandidates, encodeFrame, OPCODE } from './ipc'

const HANDSHAKE_TIMEOUT_MS = 5_000
const COMMAND_TIMEOUT_MS = 5_000

type RpcMessage = {
  evt?: string
  nonce?: string
  message?: string
  data?: { message?: string } | null
}

type PendingCommand = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type DiscordClientOptions = {
  clientId: string
  candidates?: () => string[]
  onClose?: () => void
  log?: (message: string) => void
}

export type DiscordClient = {
  connect: () => Promise<void>
  isConnected: () => boolean
  setActivity: (activity: object) => Promise<unknown>
  clearActivity: () => Promise<unknown>
  close: () => Promise<void>
  destroySocketForTest: () => void
}

function connectToFirstAvailable(candidates: string[]): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let index = 0
    const attempt = () => {
      if (index >= candidates.length) {
        reject(new Error('no discord ipc socket accepted a connection'))
        return
      }
      const candidate = candidates[index++]
      const socket = net.createConnection(candidate)
      const onError = () => {
        socket.destroy()
        attempt()
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        resolve(socket)
      })
    }
    attempt()
  })
}

function defaultCandidates(): string[] {
  return discordIpcCandidates({
    platform: process.platform,
    env: process.env,
    uid: typeof os.userInfo === 'function' ? os.userInfo().uid : undefined
  })
}

export function createDiscordClient({
  clientId,
  candidates = defaultCandidates,
  onClose = () => {},
  log = () => {}
}: DiscordClientOptions): DiscordClient {
  let socket: net.Socket | null = null
  let connected = false
  let closeNotified = false
  const pending = new Map<string, PendingCommand>()
  let onReady: (() => void) | null = null

  function teardown() {
    connected = false
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('discord connection closed'))
    }
    pending.clear()
    if (socket) {
      socket.removeAllListeners()
      socket.destroy()
      socket = null
    }
    if (!closeNotified) {
      closeNotified = true
      onClose()
    }
  }

  function handleFrame(opcode: number, data: unknown) {
    if (opcode === OPCODE.PING) {
      socket?.write(encodeFrame(OPCODE.PONG, data))
      return
    }
    const payload = data as RpcMessage | null
    if (opcode === OPCODE.CLOSE) {
      log(`discord closed the connection: ${payload?.message ?? 'no reason given'}`)
      teardown()
      return
    }
    if (opcode !== OPCODE.FRAME) {
      return
    }
    if (payload?.evt === 'READY') {
      onReady?.()
      return
    }
    const entry = payload?.nonce ? pending.get(payload.nonce) : undefined
    if (!entry || !payload?.nonce) {
      return
    }
    clearTimeout(entry.timer)
    pending.delete(payload.nonce)
    if (payload.evt === 'ERROR') {
      entry.reject(new Error(payload.data?.message ?? 'discord rejected the command'))
    } else {
      entry.resolve(payload.data ?? null)
    }
  }

  async function connect() {
    if (connected) {
      return
    }
    closeNotified = false
    socket = await connectToFirstAvailable(candidates())
    const decoder = createFrameDecoder(handleFrame, (error) => {
      const message = error instanceof Error ? error.message : String(error)
      log(`discord frame error: ${message}`)
      teardown()
    })
    socket.on('data', (chunk) => decoder.push(chunk))
    socket.on('close', teardown)
    socket.on('error', (error) => {
      log(`discord socket error: ${error.message}`)
      teardown()
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        teardown()
        reject(new Error('discord handshake timed out'))
      }, HANDSHAKE_TIMEOUT_MS)
      onReady = () => {
        clearTimeout(timer)
        onReady = null
        connected = true
        resolve()
      }
      socket?.write(encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: clientId }))
    })
  }

  function command(cmd: string, args: object) {
    if (!connected || !socket) {
      return Promise.reject(new Error('not connected to discord'))
    }
    const nonce = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(nonce)
        reject(new Error(`discord ${cmd} timed out`))
      }, COMMAND_TIMEOUT_MS)
      pending.set(nonce, { resolve, reject, timer })
      socket?.write(encodeFrame(OPCODE.FRAME, { cmd, args, nonce }))
    })
  }

  return {
    connect,
    isConnected: () => connected,
    setActivity: (activity) => command('SET_ACTIVITY', { pid: process.pid, activity }),
    clearActivity: () => command('SET_ACTIVITY', { pid: process.pid, activity: null }),
    async close() {
      if (socket && connected) {
        try {
          await command('SET_ACTIVITY', { pid: process.pid, activity: null })
        } catch {
          // Discord already gone; nothing to clear.
        }
      }
      teardown()
    },
    // Test seam: simulate an abrupt peer disappearance.
    destroySocketForTest: () => socket?.destroy()
  }
}
