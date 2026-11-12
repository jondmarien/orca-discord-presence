# Panel Responsive + Hide/Show + Full Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-lean:subagent-driven-development (recommended) or superpowers-lean:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make panel fully responsive, add per-section eye hide/show with tray, theme panel via Orca vars.

**Architecture:** CSS-first responsive (container + media fallback), panel.js hidden-set in storage + settings mirror, theme var audit replacing hardcodes. No new deps, no worker rewrite.

**Tech Stack:** Vanilla CSS/JS inline (`src/panel/*` → `panel/index.html` via `bun run build:panel`), TypeScript worker (`src/presence/*`), bun test.

**Spec:** `docs/superpowers/specs/2026-11-12-panel-responsive-design.md`

## Global Constraints

- No page-level horizontal scroll; only Detail `.seg` may scroll internally.
- `min-width:0` on all flex children; `overflow-wrap:anywhere` kept.
- Storage key `panelHidden: string[]`; settings key `hiddenPanels` comma-list in `orca-plugin.json contributes.settings`.
- Load merge: settings first, storage overwrites; writes go both.
- No new dependencies. No JS resize observer.
- `bun run build` + `bun test` green every task.

## Review Focus

- 180px sidebar: legend dots only, no ellipsis overflow, tiles become color bars — expect no scroll.
- Junk `storage.panelHidden` (unknown IDs, non-array) ignored, panel still renders.
- `hiddenPanels` hand-edited junk in settings normalized, no crash.
- Light theme: no dark hardcoded blocks, contrast readable.
- Eye toggles keyboard accessible (`aria-pressed`, focus-visible).

---

### Task 1: Responsive CSS

**Files:**
- Modify: `src/panel/panel.css`
- Modify: `src/panel/panel.html` (only if wrappers needed)
- Test: `test/panel-build.test.ts` (existing build-sync test)

**Interfaces:**
- Consumes: existing IDs `#status-bar, #strip-card, #full-b, .dcard, .seg, .agent-row, #min-hero`
- Produces: responsive rules for Task 2 tray + Task 4 theme to inherit

- [ ] **Step 1: Add failing check — narrow render has no overflow**

In `test/panel-build.test.ts` add assertion that built `panel/index.html` CSS contains `flex-wrap:wrap` for `#status-bar` and `.leg`, and `min-width:0` for `.dtext/.agent-label`. Run to fail.

- [ ] **Step 2: Run to verify fail**

Run: `bun test test/panel-build.test.ts`
Expected: FAIL missing rules

- [ ] **Step 3: Implement responsive rules in `src/panel/panel.css`**

Header wrap, leg wrap + `<240px` label hide, tiles `1fr 1fr → 1fr (<260px) → bars (<180px)`, dcard img 48px, seg `overflow-x:auto`, agent chip `max-width:40%`, hero img 88px. Container queries + `@media` fallback + `@supports color-mix` fallback.

- [ ] **Step 4: Rebuild + test pass**

Run: `bun run build:panel && bun test test/panel-build.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/panel/panel.css panel/index.html test/panel-build.test.ts
git commit -m "feat: responsive panel compact-until-colors"
```

### Task 2: Eyes + hidden tray (panel only)

**Files:**
- Modify: `src/panel/panel.html`
- Modify: `src/panel/panel.css`
- Modify: `src/panel/panel.js`
- Test: `test/panel-build.test.ts`

**Interfaces:**
- Consumes: Task 1 CSS breakpoints
- Produces: `PANEL_SECTIONS` id map + `panelHidden` storage helpers for Task 3

- [ ] **Step 1: Write failing test — eye buttons exist**

Extend `test/panel-build.test.ts` FakeElement run: built HTML contains `btn-show-all`, `data-hide="strip"` etc., `#hidden-tray`. Run to fail.

- [ ] **Step 2: Run to verify fail**

Run: `bun test test/panel-build.test.ts`
Expected: FAIL missing eyes

- [ ] **Step 3: Implement `src/panel/panel.html` eyes**

Add `btn-show-all` eye btn between `#view-switch` + `#btn-refresh` (badge span), per-card eye btn in each section header (`data-hide` IDs: preview/strip/tiles/sink/client/detail/agents/toggles/actions/logs), `#hidden-tray` row.

- [ ] **Step 4: Implement `src/panel/panel.js` hidden-set**

`PANEL_SECTIONS` map ID→DOM selector from spec, `loadHidden()` (settings then storage), `applyHidden()` (hidden wins over FULL_ONLY), `toggleHidden()`, tray render with restore chips, persist to `storage.set panelHidden` immediate + `settings.set hiddenPanels` debounced. Eye SVG open/off, `aria-pressed`.

- [ ] **Step 5: Style eyes/tray in `src/panel/panel.css`**

`.eye-btn` 22px icon-btn, badge count, `#hidden-tray` chips row, focus-visible outline.

- [ ] **Step 6: Rebuild + test pass**

Run: `bun run build:panel && bun test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/panel/panel.html src/panel/panel.css src/panel/panel.js panel/index.html test/panel-build.test.ts
git commit -m "feat: per-section eye hide with show-all tray"
```

### Task 3: Settings mirror + snapshot

**Files:**
- Modify: `orca-plugin.json`
- Modify: `src/presence/settings.ts`
- Modify: `src/presence/panel-snapshot.ts`
- Test: `test/presence-settings.test.ts`, `test/presence-panel-snapshot.test.ts`

**Interfaces:**
- Consumes: Task 2 `panelHidden` IDs
- Produces: `hiddenPanels` normalized string consumed by panel `loadHidden()`

- [ ] **Step 1: Write failing settings test**

In `test/presence-settings.test.ts`: `normalizeSettings({hiddenPanels:'strip,tiles'})` → `'strip,tiles'`, junk → `''`, unknown IDs dropped. Run to fail.

- [ ] **Step 2: Run to verify fail**

Run: `bun test test/presence-settings.test.ts`
Expected: FAIL no hiddenPanels

- [ ] **Step 3: Implement `hiddenPanels` in `src/presence/settings.ts`**

Add `hiddenPanels: string` to type + DEFAULT `''`, normalize: split comma, trim, keep known IDs only (preview/strip/tiles/sink/client/detail/agents/toggles/actions/logs), join. Add to `SETTING_KEYS_DECLARED` via DEFAULT (auto). Add manifest entry in `orca-plugin.json` (`key:hiddenPanels`, title `Hidden panels`, type string, default `''`).

- [ ] **Step 4: Include `hidden` in `src/presence/panel-snapshot.ts`**

Add `hidden: string[]` to snapshot (from settings.hiddenPanels split), test in `test/presence-panel-snapshot.test.ts`.

- [ ] **Step 5: Run tests pass**

Run: `bun test test/presence-settings.test.ts test/presence-panel-snapshot.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add orca-plugin.json src/presence/settings.ts src/presence/panel-snapshot.ts test/presence-settings.test.ts test/presence-panel-snapshot.test.ts
git commit -m "feat: hiddenPanels settings mirror + snapshot"
```

### Task 4: Full auto-theme

**Files:**
- Modify: `src/panel/panel.css`
- Modify: `src/panel/panel.js` (applyTheme extend)
- Test: `test/panel-build.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2 CSS classes
- Produces: theme-complete panel, no hardcodes

- [ ] **Step 1: Write failing test — no hardcoded dark**

Add assertion built CSS has no `#232428`, `#3a3a3a`, `#161616` outside `[data-theme]` fallback, contains `[data-theme="light"]`. Run to fail.

- [ ] **Step 2: Run to verify fail**

Run: `bun test test/panel-build.test.ts`
Expected: FAIL hardcodes present

- [ ] **Step 3: Replace hardcodes with `var(--orca-*)` in `src/panel/panel.css`**

`.dcard, .hero, .sw, .chip, pre.log, .btn, .select, .seg` → `var(--orca-background/card/border/foreground/muted-foreground/muted)` + light fallbacks `--bg:#f5f5f5 --card:#fff --border:#e0e0e0 --fg:#1a1a1a --muted-fg:#666`. Keep `--c-*` glow hues. Add `[data-theme=light]` + `prefers-color-scheme` fallback, `@supports` for `color-mix`.

- [ ] **Step 4: Extend `applyTheme()` in `src/panel/panel.js`**

Read storage theme on load + keep `orca.on('theme')` listener. No new RPC.

- [ ] **Step 5: Rebuild + test pass**

Run: `bun run build:panel && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/panel/panel.css src/panel/panel.js panel/index.html test/panel-build.test.ts
git commit -m "feat: full auto-theme via orca vars"
```

### Task 5: Build verify + PR

**Files:**
- Modify: `CHANGELOG.md` (brief)

**Interfaces:**
- Consumes: Tasks 1-4
- Produces: merge-ready branch

- [ ] **Step 1: Full verify**

Run: `bun run build && bun test && bun run typecheck`
Expected: PASS all

- [ ] **Step 2: Manual checklist (record results in PR body)**

Widths 320/260/200/170px no page scroll, hide each + reload persists + Show-all, light/dark toggle.

- [ ] **Step 3: Commit + push + PR**

```bash
git add CHANGELOG.md && git commit -m "docs: changelog panel refresh" && git push -u origin responsive-panel && gh pr create --title "Panel responsive + hide/show + theme" --body "Spec docs/superpowers/specs/2026-11-12-panel-responsive-design.md ..."
```
