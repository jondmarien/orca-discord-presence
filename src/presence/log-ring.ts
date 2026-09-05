/**
 * In-memory ring buffer of recent diagnostic lines for the panel snapshot.
 *
 * The sandboxed panel cannot read the on-disk log or call `storage.*`, so
 * the worker keeps a small tail here and embeds it into `panel/index.html`
 * when the install directory is writable.
 *
 * @module presence/log-ring
 * @author Jonathan Marien
 * @date 2026-09-05
 */

/**
 * Default number of recent lines kept for the diagnostics panel.
 */
export const PANEL_LOG_RING_SIZE = 80

/**
 * Circular buffer of formatted log lines (oldest first).
 */
export type LogRing = {
  /** Append a line, dropping the oldest when over capacity. */
  push: (line: string) => void
  /** Copy of the current lines, oldest first. */
  lines: () => string[]
  /** Drop every stored line (does not touch the on-disk file). */
  clear: () => void
  /** Configured capacity. */
  capacity: number
}

/**
 * Create a bounded log ring. Capacity is clamped to at least 1.
 *
 * @param capacity - Maximum lines to retain.
 */
export function createLogRing(capacity = PANEL_LOG_RING_SIZE): LogRing {
  const max = Math.max(1, Math.floor(capacity))
  const buf: string[] = []
  return {
    capacity: max,
    push(line) {
      buf.push(line)
      if (buf.length > max) {
        buf.splice(0, buf.length - max)
      }
    },
    lines() {
      return buf.slice()
    },
    clear() {
      buf.length = 0
    }
  }
}
