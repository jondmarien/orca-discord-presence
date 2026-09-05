# Panel version single source of truth

Author: Jonathan Marien  
Date: 2026-09-05

Design for the diagnostics panel still showing `v0.4.0` after the plugin bumped to `0.5.0`. This spec is the approved scope from the implement-as-PR brief (Cloud Agent; no interactive review loop).

## Problem

`PLUGIN_VERSION` in `src/version.ts` is already `0.5.0` and stays in lockstep with `package.json` / `orca-plugin.json` via `test/entry.test.ts`. The sidebar panel does not.

`panel/index.html` hardcodes:

- `#version-badge` → `v0.4.0`
- `#about-version` → `0.4.0`

The inline script only overwrites those nodes when a worker snapshot is present (`snapshot.version`). Marketplace / immutable installs never get a rewrite. Writable Omarchy `devPluginPaths` installs still show `0.4.0` until a rewrite runs — and the committed shell they start from is already stale.

Root cause: the static fallbacks are a second, forgotten source of truth. Every release can drift.

## Constraints

- Do **not** treat a one-off `0.4.0` → `0.5.0` HTML edit as the fix. That repeats the bug next bump.
- Source of truth stays `PLUGIN_VERSION` (already aligned with package / manifest).
- Marketplace / static shells must show the current version **before** a live snapshot.
- Do not bump product version to `0.5.1` unless release/CI forces it. Prefer a patch on `0.5.0`.
- File-level `@author Jonathan Marien` JSDoc only on files we touch. No per-method author tags.
- Tests must fail CI if someone bumps `PLUGIN_VERSION` and forgets the panel.
- Panel stays inline CSS/JS only (host CSP). No extra script files.
- Context7 not required for this change (no new library API).

## Approaches considered

1. **Stamp + shipped JSON marker + CI lock (recommended).** Add `#plugin-version` (same pattern as `#presence-snapshot`). `stampPanelVersion(html, version)` rewrites that script plus the badge / About nodes. `embedPanelSnapshot` always stamps (`snapshot?.version ?? PLUGIN_VERSION`). Panel JS applies snapshot version, else the shipped JSON. Tests assert the committed shell matches `PLUGIN_VERSION`.
2. **Build-time HTML codegen only.** `bun run build` rewrites the panel. Release zip would be correct, but a git checkout / marketplace copy of unstamped HTML stays stale unless we also commit the generated file — and then we still need the same CI lock as (1). Extra script, same outcome.
3. **HTML-only bump to `0.5.0`.** Fixes Omarchy today. Drifts again at `0.6.0`. Rejected by the brief.

Recommendation: **(1)**. Rewrite path self-heals writable installs. Committed + stamped shell fixes marketplace. CI makes the next bump fail closed.

## Design

### Source of truth

`PLUGIN_VERSION` in `src/version.ts`. Package and manifest already must match. The panel becomes a consumer, not a peer constant.

### HTML marker

Right after `#presence-snapshot`:

```html
<script id="plugin-version" type="application/json">"0.5.0"</script>
```

`#version-badge` and `#about-version` keep visible text for first paint / no-JS. They are derived; `stampPanelVersion` writes all three from one `version` string.

### Worker rewrite

`stampPanelVersion` lives in `src/presence/panel-html.ts` (same module that already patches the snapshot script).

`embedPanelSnapshot` runs the existing snapshot replace, then stamps:

- snapshot present → `snapshot.version`
- snapshot `null` → `PLUGIN_VERSION`

Writable installs therefore correct a stale shell on the next activate / Show Status / heartbeat rewrite. Missing `#plugin-version` must not abort the snapshot write: stamp the badge / About ids when present; replace the script when present.

### Panel JS

`renderSnapshot` already sets the two nodes from `snapshot.version`. Also read `#plugin-version` when the snapshot is `null` / missing `version`, so a static marketplace shell paints `0.5.0` after JS runs even if someone left the badge text stale (the CI test should prevent that).

### Tests

In `test/presence-panel.test.ts` (and entry if needed):

1. **Shipped shell lock:** committed `panel/index.html` `#plugin-version`, `#version-badge` (`v${PLUGIN_VERSION}`), and `#about-version` all equal `PLUGIN_VERSION`. This is the “forgot to update the panel” CI failure.
2. **Stamp mechanism:** given HTML with `0.4.0`, `stampPanelVersion(html, PLUGIN_VERSION)` writes the current version in all three places.
3. **Embed stamps:** `embedPanelSnapshot` with a snapshot version updates display; `embedPanelSnapshot(html, null)` still stamps `PLUGIN_VERSION`.

No live Discord. No product version bump.

### Docs

One paragraph in `docs/architecture.md` (sidebar panel) and a single diagnostics bullet in `README.md`: the panel version is stamped from `PLUGIN_VERSION`, not a hand-edited fallback.

## Out of scope

- Companion `package.json` still at `0.4.0` (separate package; not the sidebar badge).
- Generating the whole panel from TypeScript.
- Host B4 / issue #10 (panel-callable settings).
