/**
 * Structured diagnostics for `orca.log` and an optional on-disk log file.
 *
 * Host `orca.log` is easy to miss in the UI, so the same lines are appended
 * to an XDG/LOCALAPPDATA state file (capped). Connect failures are always
 * written; `info` / `debug` follow {@link PresenceSettings.debugLogging}.
 *
 * @module presence/log
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Qualified plugin id — also the log line prefix.
 *
 * @author Jonathan Marien
 */
export const LOG_PLUGIN_ID = 'chron0.discord-presence'

/**
 * Directory name under XDG state / LocalAppData.
 *
 * @author Jonathan Marien
 */
export const LOG_DIR_NAME = 'chron0-discord-presence'

/**
 * Log file basename.
 *
 * @author Jonathan Marien
 */
export const LOG_FILE_NAME = 'plugin.log'

/**
 * Rotate the active file when the next append would exceed this size.
 *
 * @author Jonathan Marien
 */
export const MAX_LOG_BYTES = 256 * 1024

/**
 * Override path (tests / operators). Takes precedence over XDG.
 *
 * @author Jonathan Marien
 */
export const LOG_FILE_ENV = 'ORCA_PRESENCE_LOG_FILE'

/**
 * Diagnostic severity. `error` and `warn` always reach the host log.
 *
 * @author Jonathan Marien
 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

/**
 * One of {@link LOG_LEVELS}.
 *
 * @author Jonathan Marien
 */
export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * Structured line emitter used by the controller and `activate`.
 *
 * @author Jonathan Marien
 */
export type DiagnosticSink = {
  line: (level: LogLevel, event: string, detail?: Record<string, unknown>) => void
  setDebugEnabled: (enabled: boolean) => void
  filePath: string
}

/**
 * Keys that must never appear in a log line (bridge token, headers).
 *
 * @author Jonathan Marien
 */
const REDACTED_KEYS = new Set(['token', 'bridgetoken', 'authorization', 'password', 'secret'])

/**
 * Inputs for {@link resolveLogFilePath}. Injected so tests can simulate
 * Windows LocalAppData and XDG without writing to the real home directory.
 *
 * @author Jonathan Marien
 */
export type LogPathInput = {
  homedir: string
  tmpdir: string
  platform: string
}

/**
 * Pick the on-disk log path.
 *
 * Order: `ORCA_PRESENCE_LOG_FILE`, `XDG_STATE_HOME`, Windows `LOCALAPPDATA`,
 * `~/.local/state/chron0-discord-presence/plugin.log`, then tmpdir.
 *
 * @author Jonathan Marien
 */
export function resolveLogFilePath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  { homedir, tmpdir, platform }: LogPathInput
): string {
  const override = env[LOG_FILE_ENV]
  if (typeof override === 'string' && override.trim()) {
    return override.trim()
  }
  const xdg = env.XDG_STATE_HOME
  if (typeof xdg === 'string' && xdg.trim()) {
    return join(xdg.trim(), LOG_DIR_NAME, LOG_FILE_NAME)
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (typeof local === 'string' && local.trim()) {
      return join(local.trim(), LOG_DIR_NAME, LOG_FILE_NAME)
    }
    return join(tmpdir, LOG_DIR_NAME, LOG_FILE_NAME)
  }
  if (homedir) {
    return join(homedir, '.local', 'state', LOG_DIR_NAME, LOG_FILE_NAME)
  }
  return join(tmpdir, LOG_DIR_NAME, LOG_FILE_NAME)
}

/**
 * Format one structured line. Values with spaces are JSON-quoted.
 * Redacted keys are replaced with `***`.
 *
 * @author Jonathan Marien
 */
export function formatLogLine(
  level: LogLevel,
  event: string,
  detail: Record<string, unknown> = {}
): string {
  const parts = [`[${LOG_PLUGIN_ID}]`, level, event]
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) {
      continue
    }
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      parts.push(`${key}=***`)
      continue
    }
    const rendered =
      typeof value === 'string' && /[\s=]/.test(value) ? JSON.stringify(value) : String(value)
    parts.push(`${key}=${rendered}`)
  }
  return parts.join(' ')
}

/**
 * Append a line, rotating `file` → `file.1` when the cap would be exceeded.
 *
 * @author Jonathan Marien
 */
export function appendCappedLog(filePath: string, line: string, maxBytes = MAX_LOG_BYTES): void {
  mkdirSync(dirname(filePath), { recursive: true })
  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    size = 0
  }
  const payload = line.endsWith('\n') ? line : `${line}\n`
  if (size + Buffer.byteLength(payload) > maxBytes) {
    try {
      renameSync(filePath, `${filePath}.1`)
    } catch {
      // Rotation is best-effort; still append.
    }
  }
  appendFileSync(filePath, payload, 'utf8')
}

/**
 * Host + file sink. `error` / `warn` always go to `orca.log` (and the file).
 * `info` / `debug` require `debugEnabled`. File writes never throw.
 *
 * @author Jonathan Marien
 */
export function createDiagnosticSink({
  hostLog,
  filePath,
  debugEnabled,
  append = appendCappedLog
}: {
  hostLog: (message: string) => void
  filePath: string
  debugEnabled: boolean
  append?: (filePath: string, line: string) => void
}): DiagnosticSink {
  let debug = debugEnabled
  return {
    filePath,
    setDebugEnabled(enabled) {
      debug = enabled
    },
    line(level, event, detail) {
      const always = level === 'error' || level === 'warn'
      if (!debug && !always) {
        return
      }
      const formatted = formatLogLine(level, event, detail)
      hostLog(formatted)
      try {
        append(filePath, formatted)
      } catch {
        // Disk full / read-only home must not take down the worker.
      }
    }
  }
}
