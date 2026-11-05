/**
 * Inline `src/panel/{panel.html,panel.css,panel.js}` into `panel/index.html`.
 *
 * Why: the Orca frame loads one self-contained file (no `<script src>`, no
 * network, browser clients too), but the source is easier to edit split up.
 * A test fails when the committed `panel/index.html` differs from a fresh
 * build, so a forgotten `bun run build:panel` cannot ship.
 *
 * @module scripts/build-panel
 * @author Jonathan Marien
 * @date 2026-11-04
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (name: string): string => readFileSync(join(root, 'src/panel', name), 'utf8').trimEnd()

/**
 * Compose the panel page. The script is wrapped in a function scope because
 * a top-level `var orca` would assign to the frozen `window.orca` and throw.
 */
export function buildPanelHtml(): string {
  const script = `;(function () {\n'use strict'\n${read('panel.js')}\n})()`
  // Why: function replacers keep `$&`-style sequences in the source literal.
  return (
    read('panel.html')
      .replace('/* PANEL_STYLES */', () => read('panel.css'))
      .replace('/* PANEL_SCRIPT */', () => script) + '\n'
  )
}

if (import.meta.main) {
  writeFileSync(join(root, 'panel/index.html'), buildPanelHtml())
}
