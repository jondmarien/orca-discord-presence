/**
 * Companion HTTP server: `POST /activity` and `DELETE /activity`.
 *
 * Applies the same Discord IPC client as the plugin (`src/discord/client.ts`).
 * Auth is a shared bearer token when configured; required for any
 * non-loopback bind (enforced by {@link parseCompanionConfig}).
 *
 * @module companion/http
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { createDiscordClient } from '../src/discord/client'
import type { CompanionConfig } from './config'

/**
 * Maximum JSON body accepted on `POST /activity`.
 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Discord surface the companion needs. Matches {@link DiscordClient} so
 * tests can inject a fake without opening named pipes.
 */
export type CompanionDiscordClient = {
  connect: () => Promise<void>
  isConnected: () => boolean
  setActivity: (activity: object) => Promise<unknown>
  clearActivity: () => Promise<unknown>
  close: () => Promise<void>
}

/**
 * Construction options for {@link startCompanionServer}.
 */
export type CompanionServerOptions = {
  config: CompanionConfig
  /** Override the real IPC client (unit tests). */
  client?: CompanionDiscordClient
  /** Override socket-path discovery when constructing the real client. */
  candidates?: () => string[]
  log?: (message: string) => void
}

/**
 * Handle returned after the HTTP server is listening.
 */
export type CompanionServer = {
  url: string
  port: number
  close: () => Promise<void>
}

/**
 * Constant-time string compare that does not early-return on length.
 */
export function tokensEqual(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected)
  const providedBuf = Buffer.from(provided)
  const length = Math.max(expectedBuf.length, providedBuf.length, 1)
  const left = Buffer.alloc(length)
  const right = Buffer.alloc(length)
  expectedBuf.copy(left)
  providedBuf.copy(right)
  return timingSafeEqual(left, right) && expectedBuf.length === providedBuf.length
}

/**
 * Extract a Bearer token from `Authorization`, or `null`.
 */
function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

function isAuthorized(config: CompanionConfig, req: http.IncomingMessage): boolean {
  if (!config.token) {
    return true
  }
  const provided = bearerToken(req.headers.authorization)
  return provided !== null && tokensEqual(config.token, provided)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body?: object) {
  if (body) {
    const json = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json)
    })
    res.end(json)
    return
  }
  res.writeHead(status)
  res.end()
}

function formatListenUrl(bind: string, port: number): string {
  const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind
  const wrapped = host.includes(':') ? `[${host}]` : host
  return `http://${wrapped}:${port}`
}

function requestPath(req: http.IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1'
  return new URL(req.url ?? '/', `http://${host}`).pathname
}

function isActivityObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Start the companion HTTP listener.
 */
export async function startCompanionServer({
  config,
  client: injected,
  candidates,
  log = () => {}
}: CompanionServerOptions): Promise<CompanionServer> {
  const client: CompanionDiscordClient =
    injected ??
    createDiscordClient({
      clientId: config.clientId,
      candidates,
      log
    })

  async function ensureDiscord(): Promise<boolean> {
    if (client.isConnected()) {
      return true
    }
    try {
      await client.connect()
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`discord unavailable: ${message}`)
      return false
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const pathname = requestPath(req)
    const method = req.method ?? 'GET'

    if (pathname === '/health' && (method === 'GET' || method === 'HEAD')) {
      send(res, 200, { ok: true, discordConnected: client.isConnected() })
      return
    }

    if (pathname !== '/activity') {
      send(res, 404, { error: 'not found' })
      return
    }

    if (!isAuthorized(config, req)) {
      send(res, 401, { error: 'unauthorized' })
      return
    }

    if (method === 'POST') {
      let parsed: unknown
      try {
        const raw = await readBody(req)
        parsed = raw ? JSON.parse(raw) : null
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        send(res, 400, { error: message === 'payload too large' ? message : 'invalid json' })
        return
      }
      if (!isActivityObject(parsed)) {
        send(res, 400, { error: 'activity object required' })
        return
      }
      if (!(await ensureDiscord())) {
        send(res, 503, { error: 'discord unavailable' })
        return
      }
      try {
        await client.setActivity(parsed)
        send(res, 204)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`failed to set activity: ${message}`)
        send(res, 502, { error: 'discord rejected SET_ACTIVITY' })
      }
      return
    }

    if (method === 'DELETE') {
      if (await ensureDiscord()) {
        try {
          await client.clearActivity()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`failed to clear activity: ${message}`)
        }
      }
      send(res, 204)
      return
    }

    res.setHeader('allow', 'POST, DELETE')
    send(res, 405, { error: 'method not allowed' })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.bind, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  const url = formatListenUrl(config.bind, port)

  return {
    url,
    port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      await client.close()
    }
  }
}
