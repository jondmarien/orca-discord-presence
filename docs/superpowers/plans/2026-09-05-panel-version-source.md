# Panel Version Source of Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Discord Presence panel badge / About version always come from `PLUGIN_VERSION` so they cannot drift from `package.json` / `orca-plugin.json`.

**Architecture:** Keep `PLUGIN_VERSION` as the only semver constant. Add `stampPanelVersion` next to the existing snapshot embed. The committed `panel/index.html` carries a `#plugin-version` JSON script plus derived badge / About text. `embedPanelSnapshot` stamps on every rewrite. Panel JS reads the shipped JSON when no snapshot is present. Tests lock the committed shell to `PLUGIN_VERSION`.

**Tech Stack:** TypeScript, Bun test, static `panel/index.html` (inline JS only).

## Global Constraints

- Source of truth: `PLUGIN_VERSION` in `src/version.ts` (already `0.5.0`; keep package + manifest in lockstep; do not bump to `0.5.1`).
- Do not fix this by only editing `0.4.0` → `0.5.0` in HTML.
- Marketplace / static panel must show `0.5.0` before a live snapshot.
- File-level `@author Jonathan Marien` JSDoc only on touched/created files.
- Missing `#plugin-version` must not fail a snapshot rewrite.
- Context7 not required.

---

### Task 1: Failing tests for stamp + shipped lock

**Files:**
- Modify: `test/presence-panel.test.ts`
- Consumes: `PLUGIN_VERSION`, `embedPanelSnapshot`, shipped `panel/index.html`
- Produces: failing tests that describe `stampPanelVersion`, `extractPanelVersion`, and the shipped-shell lock

- [ ] **Step 1: Write the failing tests**

Add these imports from `../src/presence/panel-html`:

```ts
import {
  embedPanelSnapshot,
  extractPanelSnapshot,
  extractPanelVersion,
  resolvePanelHtmlPath,
  serializePanelSnapshot,
  stampPanelVersion,
  writePanelSnapshot
} from '../src/presence/panel-html'
```

Append (do not replace existing tests):

```ts
test('shipped panel HTML version markers match PLUGIN_VERSION', () => {
  const html = readFileSync(panelHtmlPath, 'utf8')
  expect(extractPanelVersion(html)).toBe(PLUGIN_VERSION)
  expect(html.includes(`id="version-badge">v${PLUGIN_VERSION}<`)).toBe(true)
  expect(html.includes(`id="about-version">${PLUGIN_VERSION}<`)).toBe(true)
})

test('stampPanelVersion rewrites stale badge, About, and version script', () => {
  const stale = [
    '<script id="plugin-version" type="application/json">"0.4.0"</script>',
    '<span class="badge" id="version-badge">v0.4.0</span>',
    '<dd id="about-version">0.4.0</dd>'
  ].join('')
  const stamped = stampPanelVersion(stale, PLUGIN_VERSION)
  expect(extractPanelVersion(stamped)).toBe(PLUGIN_VERSION)
  expect(stamped.includes(`id="version-badge">v${PLUGIN_VERSION}<`)).toBe(true)
  expect(stamped.includes(`id="about-version">${PLUGIN_VERSION}<`)).toBe(true)
  expect(stamped.includes('0.4.0')).toBe(false)
})

test('embedPanelSnapshot stamps snapshot.version and null uses PLUGIN_VERSION', () => {
  const html = readFileSync(panelHtmlPath, 'utf8')
  const snapshot = buildPresencePanelSnapshot({
    version: '9.9.9',
    status: statusWith(),
    settings: DEFAULT_SETTINGS,
    logs: []
  })
  const withSnap = embedPanelSnapshot(html, snapshot)
  expect(extractPanelVersion(withSnap)).toBe('9.9.9')
  expect(withSnap.includes('id="version-badge">v9.9.9<')).toBe(true)
  expect(withSnap.includes('id="about-version">9.9.9<')).toBe(true)
  const withNull = embedPanelSnapshot(html, null)
  expect(extractPanelVersion(withNull)).toBe(PLUGIN_VERSION)
  expect(withNull.includes(`id="version-badge">v${PLUGIN_VERSION}<`)).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/presence-panel.test.ts`

Expected: FAIL — `stampPanelVersion` / `extractPanelVersion` not exported, and shipped HTML still has `0.4.0`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add test/presence-panel.test.ts
git commit -m "test: lock panel version display to PLUGIN_VERSION"
```

---

### Task 2: stampPanelVersion + embed hook

**Files:**
- Modify: `src/presence/panel-html.ts`
- Modify: `src/version.ts` (JSDoc only: mention panel display)
- Consumes: `PLUGIN_VERSION`, existing `embedPanelSnapshot`
- Produces: `PANEL_VERSION_SCRIPT_ID`, `extractPanelVersion`, `stampPanelVersion`; `embedPanelSnapshot` stamps after the snapshot replace

- [ ] **Step 1: Implement stamp + extract in `panel-html.ts`**

Add at top (with other imports):

```ts
import { PLUGIN_VERSION } from '../version'
```

After `PANEL_SNAPSHOT_SCRIPT_ID`:

```ts
/**
 * Marker the worker stamps with {@link PLUGIN_VERSION}. Must stay in `panel/index.html`.
 */
export const PANEL_VERSION_SCRIPT_ID = 'plugin-version'

const VERSION_SCRIPT_RE = /<script id="plugin-version" type="application\/json">[\s\S]*?<\/script>/
const VERSION_BADGE_RE = /(<[^>]*\bid="version-badge"[^>]*>)[\s\S]*?(<\/span>)/
const ABOUT_VERSION_RE = /(<[^>]*\bid="about-version"[^>]*>)[\s\S]*?(<\/dd>)/
```

Add:

```ts
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

export function stampPanelVersion(html: string, version: string): string {
  let next = html
  const script = `<script id="${PANEL_VERSION_SCRIPT_ID}" type="application/json">${JSON.stringify(version)}</script>`
  if (VERSION_SCRIPT_RE.test(next)) {
    next = next.replace(VERSION_SCRIPT_RE, script)
  }
  next = next.replace(VERSION_BADGE_RE, `$1v${version}$2`)
  next = next.replace(ABOUT_VERSION_RE, `$1${version}$2`)
  return next
}
```

Change `embedPanelSnapshot` so after the snapshot replace it returns `stampPanelVersion(replaced, snapshot?.version ?? PLUGIN_VERSION)`.

Update the file-level JSDoc to mention version stamping.

In `src/version.ts`, extend the module comment: the same constant is shown in the diagnostics panel shell.

- [ ] **Step 2: Run `bun test test/presence-panel.test.ts`**

Expected: stamp + embed tests PASS; **shipped panel HTML** test still FAIL (`0.4.0` / missing script). That is correct — Task 3 stamps the shell.

- [ ] **Step 3: Commit**

```bash
git add src/presence/panel-html.ts src/version.ts
git commit -m "feat: stamp panel version from PLUGIN_VERSION on embed"
```

---

### Task 3: Stamp the committed shell + panel JS fallback

**Files:**
- Modify: `panel/index.html`
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Consumes: `stampPanelVersion` / `PLUGIN_VERSION`
- Produces: marketplace-correct first paint; JS fallback when snapshot is null

- [ ] **Step 1: Update `panel/index.html`**

Immediately after the presence-snapshot script, add:

```html
    <script id="plugin-version" type="application/json">"0.5.0"</script>
```

Set `#version-badge` text to `v0.5.0` and `#about-version` to `0.5.0` **via the stamp mechanism** (same strings `stampPanelVersion` writes — not a one-off unrelated copy).

In the inline script, add `readShippedVersion()` that `JSON.parse`s `#plugin-version`. In `renderSnapshot`, set badge / About from `snapshot && snapshot.version` **or** `readShippedVersion()` so a null snapshot still paints the shipped version.

- [ ] **Step 2: Docs**

`docs/architecture.md` sidebar panel: worker rewrite stamps `#plugin-version` + badge / About from `PLUGIN_VERSION`.

`README.md` diagnostics: one bullet that the badge / About version is `PLUGIN_VERSION`, not a hand-edited fallback.

- [ ] **Step 3: Run tests and typecheck**

Run: `bun test && bun run typecheck`

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add panel/index.html docs/architecture.md README.md
git commit -m "fix: ship panel version from PLUGIN_VERSION"
```

---

### Task 4: Full verify

- [ ] **Step 1:** `bun test && bun run typecheck && bun run build`
- [ ] **Step 2:** Confirm `dist/main.js` still embeds `PLUGIN_VERSION` and includes `plugin-version` stamp logic.
- [ ] **Step 3:** Push branch and open PR against `main`.
