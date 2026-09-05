/**
 * Embed a {@link PresencePanelSnapshot} into the static panel HTML shell
 * and stamp the panel version from {@link PLUGIN_VERSION} (or the
 * snapshot's `version` when present). Optionally rewrite the file when
 * the plugin install is writable.
 *
 * Marketplace installs are content-hashed and often read-only — write
 * failures are expected and must not take down the worker. The committed
 * `panel/index.html` always works with a `null` snapshot and must still
 * show the current plugin version.
 *
 * @module presence/panel-html
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLUGIN_VERSION } from '../version'
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

/**
 * Marker the worker stamps with {@link PLUGIN_VERSION}. Must stay in `panel/index.html`.
 */
export const PANEL_VERSION_SCRIPT_ID = 'plugin-version'

const SNAPSHOT_SCRIPT_RE = /<script id="presence-snapshot" type="application\/json">[\s\S]*?<\/script>/
const VERSION_SCRIPT_RE = /<script id="plugin-version" type="application\/json">[\s\S]*?<\/script>/
const VERSION_BADGE_RE = /(<[^>]*\bid="version-badge"[^>]*>)[\s\S]*?(<\/span>)/
const ABOUT_VERSION_RE = /(<[^>]*\bid="about-version"[^>]*>)[\s\S]*?(<\/dd>)/

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
 * Parse the shipped `#plugin-version` JSON (`undefined` when the marker is missing).
 */
export function extractPanelVersion(html: string): string | undefined {
  const match = html.match(
    /<script id="plugin-version" type="application\/json">([\s\S]*?)<\/script>/
  )
  if (!match?.[1]) {
    return undefined
  }
  const parsed = JSON.parse(match[1]) as unknown
  return typeof parsed === 'string' ? parsed : undefined
}

/**
 * Write `version` into `#plugin-version`, `#version-badge`, and `#about-version`.
 *
 * Inserts `#plugin-version` after the snapshot script when the marker is
 * missing so an older writable shell still heals. Missing badge / About
 * nodes are left alone — never abort a snapshot rewrite for them.
 */
export function stampPanelVersion(html: string, version: string): string {
  const script = `<script id="${PANEL_VERSION_SCRIPT_ID}" type="application/json">${JSON.stringify(version)}</script>`
  let next = html
  if (VERSION_SCRIPT_RE.test(next)) {
    next = next.replace(VERSION_SCRIPT_RE, script)
  } else if (SNAPSHOT_SCRIPT_RE.test(next)) {
    next = next.replace(SNAPSHOT_SCRIPT_RE, (match) => `${match}\n    ${script}`)
  }
  next = next.replace(VERSION_BADGE_RE, `$1v${version}$2`)
  next = next.replace(ABOUT_VERSION_RE, `$1${version}$2`)
  return next
}

/**
 * Replace the `#presence-snapshot` script body and stamp the panel version.
 * Throws if the snapshot marker is missing so we never write a half-patched file.
 */
export function embedPanelSnapshot(html: string, snapshot: PresencePanelSnapshot | null): string {
  if (!SNAPSHOT_SCRIPT_RE.test(html)) {
    throw new Error('panel snapshot marker missing')
  }
  const json = serializePanelSnapshot(snapshot)
  const replaced = html.replace(
    SNAPSHOT_SCRIPT_RE,
    `<script id="${PANEL_SNAPSHOT_SCRIPT_ID}" type="application/json">${json}</script>`
  )
  return stampPanelVersion(replaced, snapshot?.version ?? PLUGIN_VERSION)
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
