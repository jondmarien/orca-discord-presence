/** Bundle the browser-only TypeScript panel and inline its ordered styles. */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (name: string): string => readFileSync(join(root, 'src/panel', name), 'utf8').trimEnd()
const styleFiles = ['tokens.css', 'layout.css', 'components.css', 'responsive.css'] as const

/**
 * Compose the panel page. The script is wrapped in a function scope because
 * a top-level `var orca` would assign to the frozen `window.orca` and throw.
 */
export async function buildPanelHtml(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, 'src/panel/panel.ts')],
    target: 'browser',
    format: 'iife',
    minify: false
  })
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(`Panel bundle failed: ${result.logs.map(String).join('\n')}`)
  }
  const bundle = await result.outputs[0].text()
  const script = `;(function () {\n'use strict';\n${bundle}\n})()`
  const css = styleFiles.map((file) => read(`styles/${file}`)).join('\n\n')
  // Why: function replacers keep `$&`-style sequences in the source literal.
  return (
    read('panel.html')
      .replace('/* PANEL_STYLES */', () => css)
      .replace('/* PANEL_SCRIPT */', () => script) + '\n'
  )
}

if (import.meta.main) {
  writeFileSync(join(root, 'panel/index.html'), await buildPanelHtml())
}
