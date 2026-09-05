/**
 * Companion listen config: bind, port, token, Discord application id.
 *
 * Defaults are loopback and the shipped public Application ID. A
 * non-loopback bind without a bearer token is rejected at parse time so
 * a Tailscale/LAN listen cannot start unauthenticated.
 *
 * @module companion/config
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { BRIDGE_ENV, DEFAULT_BRIDGE_PORT, isLoopbackHost } from '../src/presence/bridge'
import { SHIPPED_APPLICATION_ID } from '../src/presence/settings'

/**
 * Parsed companion process configuration.
 */
export type CompanionConfig = {
  /** Address passed to `server.listen` (`127.0.0.1`, `0.0.0.0`, Tailscale IP, …). */
  bind: string
  port: number
  /** Shared bearer token; empty only when {@link bind} is loopback. */
  token: string
  /** Discord Application ID for the IPC handshake. */
  clientId: string
}

/**
 * Read companion config from the environment.
 *
 * @param env - `process.env` or a test map.
 * @throws If the port is not in `1…65535`, or bind is not loopback and the token is empty.
 */
export function parseCompanionConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): CompanionConfig {
  const bind = (env[BRIDGE_ENV.BIND] ?? '127.0.0.1').trim() || '127.0.0.1'
  const portRaw = env[BRIDGE_ENV.PORT] ?? String(DEFAULT_BRIDGE_PORT)
  const port = Number.parseInt(portRaw, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${BRIDGE_ENV.PORT} must be an integer 0–65535 (got ${portRaw})`)
  }
  const token = (env[BRIDGE_ENV.TOKEN] ?? '').trim()
  if (!isLoopbackHost(bind) && !token) {
    throw new Error(`${BRIDGE_ENV.TOKEN} is required when ${BRIDGE_ENV.BIND} is not loopback`)
  }
  const clientId = (env[BRIDGE_ENV.CLIENT_ID] ?? SHIPPED_APPLICATION_ID).trim() || SHIPPED_APPLICATION_ID
  return { bind, port, token, clientId }
}
