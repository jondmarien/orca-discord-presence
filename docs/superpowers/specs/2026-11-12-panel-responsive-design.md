# Panel Responsive + Hide/Show + Full Theme — Design

Date: 2026-11-12
Status: approved (3/3 sections)
Approach: A — CSS + storage (recommended)

## 1. Responsive (compact-until-colors)

Problem: narrow sidebar overflows. Screenshot: `Last 30 min` legend pushes off screen. Same class bugs: header row, tiles 2-col, dcard row, seg controls, agent rows, hero art.

Rules:
- No page-level horizontal scroll ever. `min-width:0` on all flex children, `overflow-wrap:anywhere` kept. Exception: Detail `.seg` may scroll internally (`overflow-x:auto`, `max-width:100%`) — intentional, not page scroll.
- Header `#status-bar`: `flex-wrap:wrap`, indicator `ellipsis`, controls wrap to 2nd row.
- Strip `#strip-card .leg`: `flex-wrap:wrap`, gap 8px. `<240px`: labels hidden, dots remain (just colors).
- Tiles `#full-b`: `grid 1fr 1fr` → `1fr` `<260px` → color-bars `<180px` (hide `.v/.l`, keep `.mix` 10px tall).
- Dcard: `.row.top min-width:0`, img 64px → 48px `<260px`, `.dtext` truncates.
- Detail `.seg`: `overflow-x:auto`, `max-width:100%`.
- Agents: `.agent-row min-width:0`, label ellipsis, chip `max-width:40%` ellipsis + `title` age.
- Hero: img 132px → 88px narrow, `.quote max-width:100%`.
- Impl: CSS container queries on `.frame` preferred, `@media (max-width)` fallback. `color-mix` fallback via `@supports`.

Verify: resize 320px → 180px, no overflow, screenshots.

## 2. Eyes + hidden tray (persisted + settings)

- Each hideable section gets header eye btn: eye open / eye-off SVG, `aria-pressed`, `title` Hide/Show.
- IDs → DOM: `preview=#full-a .dcard, strip=#strip-card, tiles=#full-b, client=#client-card, detail=#detail-card, agents=#full-c section[aria-label=Agents], toggles=section[aria-label=Show on Discord], actions=.row.g6, logs=#logs-box`.
- State: `storage` key `panelHidden: string[]` + new `settings` entry `hiddenPanels` (comma list, single key, declared in `orca-plugin.json contributes.settings`) mirrored for Settings page. Load merge: read `settings.hiddenPanels` first, then `storage.panelHidden` overwrites if present; writes go to both (storage immediate, settings debounced). Storage wins at runtime.
- Top bar: `btn-show-all` eye btn between `#view-switch` + `#btn-refresh`, badge count, disabled when 0 hidden.
- Hidden tray: row `#hidden-tray` when >0 hidden: `Hidden (n) [Show all]` + per-item restore chips.
- Minimal view respects same hidden set. `FULL_ONLY_IDS` + hidden combine (hidden wins).
- Worker: no new RPC except read/write `hiddenPanels` via existing `settings.set`; `panel-snapshot` includes `hidden` for initial render.

Verify: hide each, reload persists, Show-all restores, settings page toggle works.

## 3. Full auto-theme

- Goal: panel chrome follows Orca vars in light + dark. Preview no longer hardcoded dark.
- Replace: `.dcard #232428/#2f3136/#b5bac1`, `.sw #3a3a3a`, chip `rgba+hex`, `pre.log #161616`, hero fixed `#0d0e10/#f2f3f5` with `var(--orca-background/card/border/foreground/muted-foreground/muted)` + light fallbacks.
- Keep state glow hues (`--c-*`), but bg gradient mixes with theme card.
- Add `[data-theme=light]` overrides + `prefers-color-scheme` fallback. Light fallbacks: `--bg:#f5f5f5, --card:#ffffff, --border:#e0e0e0, --fg:#1a1a1a, --muted-fg:#666`. Keep existing `orca.on('theme', applyTheme)` + read `storage theme` on load.
- Audit list: `.dcard, .hero, .sw, .chip, .mix, .strip, pre.log, .btn, .select, .seg`.

Verify: toggle Orca light/dark, no hardcoded dark blocks, contrast AA.

## Out of scope

- No new deps. No worker rewrite. No JS resize observer. Windows test after merge to main by reporter.

## Test plan

- `bun run build` + `bun test` (panel-build, snapshot).
- Manual: widths 320/260/200/170px, hide/show each, light/dark.
- `ponytail:` container-query fallback may be media-query only if host iframe lacks CQ support — upgrade when verified.
