/**
 * Windows Discord presence companion entry.
 *
 * Listens for privacy-gated activity from the Orca host plugin and writes
 * `SET_ACTIVITY` to the local Discord / Vencord IPC socket. Intended to run
 * on the machine where Discord is signed in (typically Windows).
 *
 * @module companion/main
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { parseCompanionConfig } from './config'
import { startCompanionServer } from './http'

try {
  const config = parseCompanionConfig(process.env)
  const server = await startCompanionServer({
    config,
    log: (message) => {
      console.error(message)
    }
  })
  const auth = config.token ? 'bearer token required' : 'loopback, token optional'
  console.log(`orca-discord-presence companion listening on ${server.url} (${auth})`)

  const shutdown = () => {
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exit(1)
}
