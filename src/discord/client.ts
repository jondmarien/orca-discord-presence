/**
 * Discord RPC-over-IPC client: connect, handshake, SET_ACTIVITY, teardown.
 *
 * Talks to the local Discord **desktop** client only. Browser Discord has
 * no IPC socket. Handshake and command replies each time out after 5s.
 * PING frames are answered with PONG; CLOSE or socket errors tear down and
 * invoke `onClose` once.
 *
 * @module discord/client
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { randomUUID } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import { createFrameDecoder, discordIpcCandidates, encodeFrame, OPCODE } from './ipc'

/**
 * How long to wait for a `READY` dispatch after sending the handshake.
 *
 * @author Jonathan Marien
 */
const HANDSHAKE_TIMEOUT_MS = 5_000

/**
 * How long to wait for a SET_ACTIVITY (or other RPC) reply nonce.
 *
 * @author Jonathan Marien
 */
const COMMAND_TIMEOUT_MS = 5_000

/**
 * Minimal Discord RPC JSON body this client inspects on inbound frames.
 *
 * @author Jonathan Marien
 */
type RpcMessage = {
  evt?: string
  nonce?: string
  message?: string
  data?: { message?: string } | null
}

/**
 * In-flight RPC command waiting on a matching `nonce`.
 *
 * @author Jonathan Marien
 */
type PendingCommand = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Construction options for {@link createDiscordClient}.
 *
 * @author Jonathan Marien
 */
export type DiscordClientOptions = {
  /** Discord Application ID sent in the handshake `client_id`. */
  clientId: string
  /**
   * Override socket-path discovery (tests inject a fake path). Defaults to
   * {@link discordIpcCandidates} for the current process platform/env/uid.
   */
  candidates?: () => string[]
  /** Called once when the socket closes or handshake/frame errors tear down. */
  onClose?: () => void
  /** Optional diagnostic logger (frame errors, socket errors, peer CLOSE). */
  log?: (message: string) => void
}

/**
 * Stateful Discord IPC client used by the presence controller.
 *
 * @author Jonathan Marien
 */
export type DiscordClient = {
  /** Connect to the first accepting IPC socket and complete the handshake. */
  connect: () => Promise<void>
  /** Whether a handshake has completed and the socket is still up. */
  isConnected: () => boolean
  /**
   * Send `SET_ACTIVITY` with this process pid and the given activity object.
   * Rejects if not connected or if Discord times out / returns `ERROR`.
   */
  setActivity: (activity: object) => Promise<unknown>
  /** Send `SET_ACTIVITY` with `activity: null` to clear the profile. */
  clearActivity: () => Promise<unknown>
  /** Best-effort clear, then destroy the socket and reject pending commands. */
  close: () => Promise<void>
  /** Test seam: simulate an abrupt peer disappearance. */
  destroySocketForTest: () => void
}

/**
 * Try each candidate path in order until one TCP/named-pipe connect succeeds.
 *
 * @param candidates - Socket or named-pipe paths, most-likely first.
 * @returns The connected `net.Socket`.
 * @throws If every candidate errors (typical when Discord desktop is closed).
 */
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

/**
 * Default candidate list for the live plugin worker (platform, env, uid).
 */
function defaultCandidates(): string[] {
  return discordIpcCandidates({
    platform: process.platform,
    env: process.env,
    uid: typeof os.userInfo === 'function' ? os.userInfo().uid : undefined
  })
}

/**
 * Create a Discord RPC-over-IPC client.
 *
 * Connection is lazy: `connect()` must be called before commands. A failed
 * handshake destroys the socket so the next `connect()` starts clean.
 *
 * @param options - Application id, optional path override, close/log hooks.
 * @returns A {@link DiscordClient} bound to those options.
 * @author Jonathan Marien
 */
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
