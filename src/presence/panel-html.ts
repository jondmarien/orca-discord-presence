/**
 * Embed a {@link PresencePanelSnapshot} into the static panel HTML shell
 * and optionally rewrite it on disk when the plugin install is writable.
 *
 * Marketplace installs are content-hashed and often read-only — write
 * failures are expected and must not take down the worker. The committed
 * `panel/index.html` always works with a `null` snapshot.
 *
 * @module presence/panel-html
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PresencePanelSnapshot } from './panel-snapshot'

/**
 * Override path for the panel HTML (tests / operators).
 */
export const PANEL_HTML_ENV = 'ORCA_PRESENCE_PANEL_HTML'

/**
 * Set to `1` / `true` to skip rewriting the panel HTML.
 */
export const PANEL_WRITE_SKIP_ENV = 'ORCA_PRESENCE_SKIP_PANEL_WRITE'

/**
 * Marker element the worker rewrites. Must stay in `panel/index.html`.
 */
export const PANEL_SNAPSHOT_SCRIPT_ID = 'presence-snapshot'

const SNAPSHOT_SCRIPT_RE = /<script id="presence-snapshot" type="application\/json">[\s\S]*?<\/script>/

/**
 * Result of {@link writePanelSnapshot}.
 */
export type PanelWriteResult = { ok: true } | { ok: false; reason: string }

/**
 * Resolve the panel HTML path.
 *
 * Order: skip env → `ORCA_PRESENCE_PANEL_HTML` → `../panel/index.html`
 * relative to `metaUrl` (`src/main.ts` or `dist/main.js`).
 */
export function resolvePanelHtmlPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  metaUrl: string
): string | null {
  const skip = env[PANEL_WRITE_SKIP_ENV]
  if (skip === '1' || skip === 'true') {
    return null
  }
  const override = env[PANEL_HTML_ENV]
  if (typeof override === 'string' && override.trim()) {
    return override.trim()
  }
  try {
    return fileURLToPath(new URL('../panel/index.html', metaUrl))
  } catch {
    return null
  }
}

/**
 * JSON for the snapshot script. `<` is escaped so a crafted string cannot
 * close the `<script>` tag.
 */
export function serializePanelSnapshot(snapshot: PresencePanelSnapshot | null): string {
  return JSON.stringify(snapshot).replace(/</g, '\\u003c')
}

/**
 * Replace the `#presence-snapshot` script body. Throws if the marker is
 * missing so we never write a half-patched file.
 */
export function embedPanelSnapshot(html: string, snapshot: PresencePanelSnapshot | null): string {
  if (!SNAPSHOT_SCRIPT_RE.test(html)) {
    throw new Error('panel snapshot marker missing')
  }
  const json = serializePanelSnapshot(snapshot)
  return html.replace(
    SNAPSHOT_SCRIPT_RE,
    `<script id="${PANEL_SNAPSHOT_SCRIPT_ID}" type="application/json">${json}</script>`
  )
}

/**
 * Parse the embedded snapshot JSON (`null` when the shipped shell is unused).
 */
export function extractPanelSnapshot(html: string): unknown {
  const match = html.match(
    /<script id="presence-snapshot" type="application\/json">([\s\S]*?)<\/script>/
  )
  if (!match?.[1]) {
    return undefined
  }
  return JSON.parse(match[1]) as unknown
}

/**
 * Best-effort rewrite of `filePath`. Never throws.
 */
export function writePanelSnapshot(filePath: string, snapshot: PresencePanelSnapshot): PanelWriteResult {
  try {
    const current = readFileSync(filePath, 'utf8')
    const next = embedPanelSnapshot(current, snapshot)
    if (next !== current) {
      writeFileSync(filePath, next, 'utf8')
    }
    return { ok: true }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') {
      return { ok: false, reason: 'missing' }
    }
    if (err?.code === 'EACCES' || err?.code === 'EROFS' || err?.code === 'EPERM') {
      return { ok: false, reason: 'unwritable' }
    }
    if (error instanceof Error && error.message.includes('snapshot marker')) {
      return { ok: false, reason: 'no-marker' }
    }
    return { ok: false, reason: error instanceof Error ? error.message : 'error' }
  }
}
