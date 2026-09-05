/**
 * Opt-in HTTP bridge: privacy-gated activity → Discord-IPC companion.
 *
 * Local Discord IPC cannot cross machines. When the Orca host has no
 * desktop Discord (typical Omarchy split) and the operator enables the
 * bridge, the already-gated activity JSON is POSTed to a companion that
 * calls `SET_ACTIVITY` on another OS. This module is the client, URL/token
 * hygiene, and loopback checks — not a second privacy boundary.
 *
 * @module presence/bridge
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import type { DiscordActivity } from './activity'
import type { PresenceSettings } from './settings'

/**
 * Default companion listen port. Documented in the README; keep in sync
 * with `companion/config.ts` defaults.
 */
export const DEFAULT_BRIDGE_PORT = 3848

/**
 * How long the plugin waits for the companion before aborting a publish
 * or clear. Must stay well under the host command budget.
 */
const BRIDGE_TIMEOUT_MS = 5_000

/**
 * Reject absurd URLs and tokens so hand-edited settings cannot become
 * multi-kilobyte headers.
 */
const MAX_BRIDGE_URL_LENGTH = 512
const MAX_BRIDGE_TOKEN_LENGTH = 256

/**
 * Env keys shared by the plugin overlay and the companion process.
 */
export const BRIDGE_ENV = {
  ENABLED: 'ORCA_PRESENCE_BRIDGE_ENABLED',
  URL: 'ORCA_PRESENCE_BRIDGE_URL',
  TOKEN: 'ORCA_PRESENCE_BRIDGE_TOKEN',
  BIND: 'ORCA_PRESENCE_BIND',
  PORT: 'ORCA_PRESENCE_PORT',
  CLIENT_ID: 'ORCA_PRESENCE_CLIENT_ID'
} as const

/**
 * Transport the presence controller uses to talk to a companion.
 */
export type PresenceBridge = {
  publish: (url: string, token: string, activity: DiscordActivity) => Promise<void>
  clear: (url: string, token: string) => Promise<void>
}

/**
 * Resolved companion target, or `null` when the bridge must stay silent.
 */
export type BridgeTarget = {
  url: string
  token: string
}

/**
 * True for loopback bind addresses and URL hosts.
 *
 * `0.0.0.0` / `::` are listen-all, not loopback. `127.0.0.0/8` and IPv6
 * `/ ::1` count as loopback so a Tailscale-less local smoke test can omit
 * a token.
 *
 * @param host - Hostname, IPv4, or IPv6 (brackets optional).
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true
  }
  if (normalized.startsWith('127.')) {
    return true
  }
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length))
  }
  return false
}

/**
 * Coerce persisted/env text into an `http(s)` companion base URL, or `''`.
 *
 * Rejects credentials-in-URL (token belongs in the bearer header),
 * non-http(s) schemes, and a trailing `/activity` so operators can paste
 * either the listen URL or a full activity path.
 */
export function normalizeBridgeUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    return ''
  }
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_BRIDGE_URL_LENGTH) {
    return ''
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return ''
  }
  if (parsed.username || parsed.password) {
    return ''
  }
  let pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/activity')) {
    pathname = pathname.slice(0, -'/activity'.length)
  }
  return `${parsed.origin}${pathname}`
}

/**
 * Trim and cap a shared bearer token; non-strings become `''`.
 */
export function normalizeBridgeToken(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_BRIDGE_TOKEN_LENGTH) : ''
}

/**
 * Whether this URL may be called without a token (loopback only).
 */
export function bridgeUrlAllowsEmptyToken(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Pick a publish target from normalized settings, or `null`.
 *
 * Rules:
 * - `bridgeEnabled` must be true and `bridgeUrl` must normalize to http(s).
 * - A non-loopback URL **requires** a token (same rule as the companion
 *   listen config). Loopback may omit it.
 */
export function resolveBridgeTarget(settings: PresenceSettings): BridgeTarget | null {
  if (!settings.bridgeEnabled) {
    return null
  }
  const url = normalizeBridgeUrl(settings.bridgeUrl)
  if (!url) {
    return null
  }
  const token = normalizeBridgeToken(settings.bridgeToken)
  if (!token && !bridgeUrlAllowsEmptyToken(url)) {
    return null
  }
  return { url, token }
}

/**
 * Overlay companion env vars onto settings at worker start.
 *
 * Host-persisted values still win when the env key is absent. An explicit
 * `ORCA_PRESENCE_BRIDGE_ENABLED=0` turns the bridge off even if storage
 * had it on — useful for a one-off disable without editing settings.
 */
export function applyBridgeEnvOverrides(
  settings: PresenceSettings,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): PresenceSettings {
  const next = { ...settings }
  const url = normalizeBridgeUrl(env[BRIDGE_ENV.URL])
  if (url) {
    next.bridgeUrl = url
  }
  const token = normalizeBridgeToken(env[BRIDGE_ENV.TOKEN])
  if (token) {
    next.bridgeToken = token
  }
  const flag = env[BRIDGE_ENV.ENABLED]
  if (flag === '1' || flag === 'true') {
    next.bridgeEnabled = true
  } else if (flag === '0' || flag === 'false') {
    next.bridgeEnabled = false
  }
  return next
}

/**
 * `POST` / `DELETE` helper used by {@link createBridgeTransport}.
 */
async function bridgeRequest(
  fetchFn: typeof fetch,
  url: string,
  token: string,
  method: 'POST' | 'DELETE',
  body?: DiscordActivity
): Promise<void> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  let payload: string | undefined
  if (method === 'POST') {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS)
  try {
    const response = await fetchFn(`${url}/activity`, {
      method,
      headers,
      body: payload,
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`bridge ${method} ${response.status}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Create a fetch-based companion transport.
 *
 * `fetch` is injectable so unit tests can stand up a fake HTTP server
 * (or a stub). Production uses global `fetch` (Node 18+ / Electron).
 */
export function createBridgeTransport({
  fetch: fetchFn = fetch,
  log = () => {}
}: {
  fetch?: typeof fetch
  log?: (message: string) => void
} = {}): PresenceBridge {
  return {
    async publish(url, token, activity) {
      try {
        await bridgeRequest(fetchFn, url, token, 'POST', activity)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`bridge publish failed: ${message}`)
        throw error
      }
    },
    async clear(url, token) {
      try {
        await bridgeRequest(fetchFn, url, token, 'DELETE')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`bridge clear failed: ${message}`)
        throw error
      }
    }
  }
}
