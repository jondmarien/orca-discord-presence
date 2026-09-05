/**
 * Discord RPC-over-IPC client: connect, handshake, SET_ACTIVITY, teardown.
 *
 * Talks to the local Discord **desktop** client only. Browser Discord has
 * no IPC socket. Handshake and command replies each time out after 5s.
 * Retryable handshake failures (READY with null data, handshake timeout)
 * retry up to 3 times with 3s → 15s capped exponential backoff. Missing
 * sockets fail immediately so the companion bridge can fail over.
 * PING frames are answered with PONG; CLOSE or socket errors tear down and
 * invoke `onClose` once. `close()` is idempotent and clears activity first.
 *
 * @module discord/client
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { randomUUID } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import { assertPlausibleApplicationId } from './app-id'
import { createFrameDecoder, discordIpcCandidates, encodeFrame, OPCODE } from './ipc'
import {
  CONNECT_RETRY_ATTEMPTS,
  CONNECT_RETRY_INITIAL_MS,
  CONNECT_RETRY_MAX_MS,
  HandshakeNotReadyError,
  isRetryableConnectError
} from './retry'

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
 * Discord's READY dispatch is usable only when `data` is a non-null object.
 * A null `data` means the pipe opened before the client finished auth.
 *
 * @author Jonathan Marien
 */
function isHandshakeReadyPayload(payload: RpcMessage | null): boolean {
  return payload?.evt === 'READY' && payload.data != null && typeof payload.data === 'object'
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
 * Diagnostic severity for {@link DiscordClientOptions.log}.
 *
 * @author Jonathan Marien
 */
export type DiscordClientLogLevel = 'info' | 'warn' | 'error'

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
  /**
   * Optional diagnostic logger (frame errors, socket errors, peer CLOSE,
   * connect retries). The optional second argument is a level; default error.
   */
  log?: (message: string, level?: DiscordClientLogLevel) => void
  /**
   * Handshake `READY` wait per attempt. Tests inject a short value.
   * Defaults to {@link HANDSHAKE_TIMEOUT_MS}.
   */
  handshakeTimeoutMs?: number
  /**
   * Retryable-handshake attempts (Burpcord: 3). Missing-socket failures
   * still fail on the first try so the companion bridge can fail over.
   */
  connectAttempts?: number
  /** Override {@link CONNECT_RETRY_INITIAL_MS} (tests). */
  retryInitialMs?: number
  /** Override {@link CONNECT_RETRY_MAX_MS} (tests). */
  retryMaxMs?: number
  /** Sleep between retries. Defaults to `setTimeout`. Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>
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
  log = () => {},
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  connectAttempts = CONNECT_RETRY_ATTEMPTS,
  retryInitialMs = CONNECT_RETRY_INITIAL_MS,
  retryMaxMs = CONNECT_RETRY_MAX_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}: DiscordClientOptions): DiscordClient {
  let socket: net.Socket | null = null
  let connected = false
  let closeNotified = false
  let closed = false
  const pending = new Map<string, PendingCommand>()
  let handshakeWait: {
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

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

  function failHandshake(error: Error) {
    const wait = handshakeWait
    handshakeWait = null
    if (wait) {
      clearTimeout(wait.timer)
    }
    teardown()
    wait?.reject(error)
  }

  function handleFrame(opcode: number, data: unknown) {
    if (opcode === OPCODE.PING) {
      socket?.write(encodeFrame(OPCODE.PONG, data))
      return
    }
    const payload = data as RpcMessage | null
    if (opcode === OPCODE.CLOSE) {
      const reason = payload?.message ?? 'no reason given'
      log(`discord closed the connection: ${reason}`)
      if (handshakeWait) {
        failHandshake(new Error(`discord closed the connection: ${reason}`))
        return
      }
      teardown()
      return
    }
    if (opcode !== OPCODE.FRAME) {
      return
    }
    if (payload?.evt === 'READY') {
      if (!isHandshakeReadyPayload(payload)) {
        log('handshake not ready (READY data was null)', 'warn')
        failHandshake(new HandshakeNotReadyError())
        return
      }
      const wait = handshakeWait
      handshakeWait = null
      if (wait) {
        clearTimeout(wait.timer)
        connected = true
        wait.resolve()
      }
      return
    }
    if (payload?.evt === 'ERROR' && handshakeWait) {
      failHandshake(new Error(payload.data?.message ?? 'discord rejected the handshake'))
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

  async function connectOnce() {
    closeNotified = false
    closed = false
    socket = await connectToFirstAvailable(candidates())
    const decoder = createFrameDecoder(handleFrame, (error) => {
      const message = error instanceof Error ? error.message : String(error)
      log(`discord frame error: ${message}`)
      if (handshakeWait) {
        failHandshake(new Error(message))
        return
      }
      teardown()
    })
    socket.on('data', (chunk) => decoder.push(chunk))
    socket.on('close', () => {
      if (handshakeWait) {
        failHandshake(new Error('discord connection closed'))
        return
      }
      teardown()
    })
    socket.on('error', (error) => {
      log(`discord socket error: ${error.message}`)
      if (handshakeWait) {
        failHandshake(error)
        return
      }
      teardown()
    })

    await new Promise<void>((resolve, reject) => {
      handshakeWait = {
        resolve,
        reject,
        timer: setTimeout(() => {
          failHandshake(new Error('discord handshake timed out'))
        }, handshakeTimeoutMs)
      }
      socket?.write(encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: clientId }))
    })
  }

  async function connect() {
    if (connected) {
      return
    }
    assertPlausibleApplicationId(clientId)
    let lastError: Error | undefined
    const attempts = Math.max(1, connectAttempts)
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await connectOnce()
        if (attempt > 1) {
          log(`connect succeeded on attempt ${attempt}/${attempts}`, 'info')
        }
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (!isRetryableConnectError(lastError) || attempt >= attempts) {
          log(`connect failed: ${lastError.message}`, 'error')
          throw lastError
        }
        const delay = Math.min(retryInitialMs * 2 ** (attempt - 1), retryMaxMs)
        log(
          `connect attempt ${attempt}/${attempts} failed: ${lastError.message}; retrying in ${delay}ms`,
          'warn'
        )
        await sleep(delay)
      }
    }
    throw lastError ?? new Error('discord connect failed')
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
      if (closed) {
        return
      }
      closed = true
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
