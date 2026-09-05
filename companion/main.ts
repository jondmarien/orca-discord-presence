/**
 * Discord presence companion entry (Linux, macOS, or Windows).
 *
 * Listens for privacy-gated activity from the Orca host plugin and writes
 * `SET_ACTIVITY` to the local Discord / Vesktop / Vencord IPC socket on
 * whichever OS this process runs. Shared path discovery covers win32 pipes
 * and POSIX sockets (including Vesktop Flatpak).
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
