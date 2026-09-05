/**
 * Live-update policy for the Discord Presence sidebar.
 *
 * Fork hosts poll `diagnostics.snapshot` every ~2s. Those polls must update
 * status / logs in place and must not reset Settings chrome. When
 * `storage.set` succeeds, the worker also skips rewriting `panel/index.html`
 * so a `devPluginPaths` file watch cannot remount the iframe.
 *
 * The sandboxed panel cannot import this module — `panel/index.html` keeps
 * an equivalent inline implementation. Tests lock both sides together.
 *
 * @module presence/panel-live
 * @author Jonathan Marien
 * @date 2026-09-05
 */

/**
 * How the panel applies a diagnostics snapshot.
 *
 * - `bootstrap`: first paint from the embedded `#presence-snapshot`.
 * - `live`: storage poll / mailbox update.
 * - `refresh`: explicit Refresh (settings come from `settings.get`).
 */
export type PanelRenderMode = 'bootstrap' | 'live' | 'refresh'

/**
 * Which Settings controls a snapshot render may touch.
 */
export type PanelRenderPolicy = {
  applyFields: boolean
  forceLogsOpen: boolean
}

/**
 * Field toggles stay on `settings.get` / user input except first paint.
 * `<details>` open state is never forced — live polls used to flip it open.
 */
export function panelRenderPolicy(mode: PanelRenderMode): PanelRenderPolicy {
  switch (mode) {
    case 'live':
    case 'refresh':
      return { applyFields: false, forceLogsOpen: false }
    case 'bootstrap':
      return { applyFields: true, forceLogsOpen: false }
    default: {
      const _exhaustive: never = mode
      throw new Error(`unhandled panel render mode: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Stable identity for a stored snapshot. `generatedAt` changes on every
 * worker heartbeat and must not by itself retrigger a panel render.
 */
export function fingerprintPanelSnapshot(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value)
  }
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'generatedAt') {
      continue
    }
    copy[key] = entry
  }
  return JSON.stringify(copy)
}

/**
 * HTML rewrite is the stock / storage-miss fallback. A successful
 * `storage.set` is enough for the fork panel poll.
 */
export function shouldRewritePanelHtml(storageWritten: boolean): boolean {
  return !storageWritten
}
