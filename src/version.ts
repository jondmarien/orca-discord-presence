/**
 * Single source of truth for the plugin semver shown in `orca.log`, the
 * diagnostics panel snapshot / `#plugin-version` shell, and activate
 * diagnostics. Keep in lockstep with `package.json` and `orca-plugin.json`.
 * `stampPanelVersion` writes this into `panel/index.html` — do not hand-edit
 * the badge or About fallbacks.
 *
 * @module version
 * @author Jonathan Marien
 * @date 2026-09-05
 */

export const PLUGIN_VERSION = '0.6.0'
