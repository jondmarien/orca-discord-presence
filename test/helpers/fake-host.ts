/**
 * Shared test harness helpers for worker entry tests: isolated temp log dir
 * management and fake Orca host construction.
 *
 * @module test/helpers/fake-host
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

/**
 * Point `ORCA_PRESENCE_LOG_FILE` at a fresh temp directory for one test and
 * return a `cleanup()` callback that restores the env var and removes the dir.
 */
export function createTempLogEnv(prefix = 'orca-presence-test-') {
  const dir = mkdtempSync(join(os.tmpdir(), prefix))
  const logFile = join(dir, 'plugin.log')
  const previous = process.env.ORCA_PRESENCE_LOG_FILE
  process.env.ORCA_PRESENCE_LOG_FILE = logFile
  return {
    dir,
    logFile,
    cleanup() {
      if (previous === undefined) {
        delete process.env.ORCA_PRESENCE_LOG_FILE
      } else {
        process.env.ORCA_PRESENCE_LOG_FILE = previous
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
