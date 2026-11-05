# Panel redesign + cover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`. Subagents for this project are Orca orchestration **terminal** workers (Sonnet 5.5).

**Goal:** Ship the approved Full/Minimal panel and Cover B before the v1.0.0 release. This replaces plan 1 Task 8's icon/cover step; that task's screenshots step stays.

**Architecture:** The worker adds a 30-minute timeline ring and privacy-safe agent rows to the panel snapshot. Panel source moves to `src/panel/` and a Bun build script inlines it into `panel/index.html`. The cover is an HTML page rendered once to PNG with headless Chromium.

**Tech Stack:** Bun, TypeScript, vanilla JS/CSS in the frame, `google-chrome-stable --headless`, ImageMagick (`magick`).

**Spec:** `docs/superpowers/specs/2026-11-04-panel-redesign-design.md` (read it, and open `docs/superpowers/specs/mockups/2026-11-04-panel-and-cover.html`, the visual reference).

## Global Constraints

- All of plan 1's Global Constraints (`docs/superpowers/plans/2026-11-04-plugin-v1-stock-orca.md`) still apply.
- `panel/index.html`: everything inline, no network, no `<script src>`, script wrapped in a function scope (never a top-level `var orca`; see `fedd05d`), and DOM writes only when a value changes (see `c6650ec`).
- State colours and fallback surfaces: exactly the table in the spec.
- Snapshot never contains terminal titles, paths, terminal ids, the bridge token, the bridge URL, the application ID or the open URL. The existing `snapshotLeaksSecrets` redaction tests must keep passing.
- Cover `assets/cover.png` is 1600×1000 and ≤1024 KB. Icon `assets/icon.png` is 256×256 and ≤256 KB.

## Review Focus

1. Worker restarted mid-session: the timeline shows `null` slots for minutes before the restart, and the panel renders them as "no data", not idle. Pinned in Task 1.
2. Minute boundaries with no events: a minute with no events carries the last known state forward, so a long "working" stretch stays cyan. Pinned in Task 1.
3. A settings write from the panel fails (rate limit or invalid): the control reverts to the snapshot value and shows the error. Pinned in Task 3.
4. Storage is unavailable or `panelView` holds junk: the panel falls back to Full. Pinned in Task 3.
5. Stale build: someone edits `src/panel/*` and forgets the build. A test catches it. Pinned in Task 2.

---

### Task 1: Timeline and agent rows in the snapshot

**Files:**
- Create: `src/presence/timeline.ts`, `test/presence-timeline.test.ts`
- Modify: `src/presence/agents.ts` (slot `kind`), `src/presence/panel-snapshot.ts`, `src/main.ts`, `test/presence-panel-snapshot.test.ts`, `test/presence-agents.test.ts`

**Interfaces:**
- Produces:
  - `type TimelineState = 'working' | 'waiting' | 'blocked' | 'idle'`
  - `type TimelineSlot = TimelineState | null`
  - `TIMELINE_MINUTES = 30`
  - `createTimeline(opts?: { now?: () => number }): { record(state: TimelineState): void; slots(): TimelineSlot[] }`
    - `record` folds into the current minute bucket (`Math.floor(now / 60000)`) by priority `blocked > waiting > working > idle`.
    - `slots()` returns exactly 30 entries, oldest first, ending at the current minute.
    - A minute after the first record with no record of its own carries the previous minute's state forward.
    - Minutes before the first record are `null`.
  - `AgentStatusEvent` and `AgentSlot` gain optional `kind?: string`. `parseAgentsList` sets `kind` from the row's `agent` (a non-empty string) and otherwise omits it. An upsert that lacks `kind` keeps the existing slot's `kind`.
  - `PresencePanelSnapshot` gains:
    - `timeline: TimelineSlot[]`
    - `agents: { kind: string; state: CanonicalAgentState; sinceMs: number }[]`, where `kind` defaults to `'agent'` and the rows are sorted by priority, then `sinceMs` ascending
    - `activityCard: { details: string; state: string | null; largeImageKey: string; smallImageKey: string; startMs: number | null } | null`, built from `status.lastActivity` (`timestamps.start * 1000`)
  - `buildPresencePanelSnapshot` input gains `timeline: TimelineSlot[]` and `agents: AgentSlot[]`.
- In `src/main.ts`, every refresh calls `timeline.record(summary.agentState ?? 'idle')` (map `done` to `idle`) before building and posting the snapshot.

- [ ] **Step 1:** Write tests:
  - `slots length is 30 and null before first record` (Review Focus 1)
  - `blocked beats working inside one minute`
  - `empty minutes carry forward last state` (Review Focus 2): record working at t0, advance 5 min, `slots().slice(-6)` all `'working'`
  - `agent kind survives a later event without kind`
  - `snapshot agents expose only kind/state/sinceMs`: `Object.keys(row)` deep-equals `['kind','state','sinceMs']`
  - `activityCard maps keys and ms timestamp`
- [ ] **Step 2:** Run `bun test`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun test && bun run typecheck && bun run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: 30-minute state timeline and agent rows in panel snapshot`.

### Task 2: Panel source split + build + Full view

**Files:**
- Create: `src/panel/panel.html` (with the `/* PANEL_STYLES */` and `/* PANEL_SCRIPT */` markers), `src/panel/panel.css`, `src/panel/panel.js`, `scripts/build-panel.ts`
- Modify: `package.json` (`"build:panel": "bun scripts/build-panel.ts"`; `"build"` runs `build:panel` then the existing bun build), `panel/index.html` (generated; first line `<!-- Generated by scripts/build-panel.ts. Edit src/panel/ instead. -->`), `test/entry.test.ts`, `tsconfig.json` if needed
- Test: `test/panel-build.test.ts`

**Interfaces:**
- Consumes: Task 1 snapshot fields.
- Produces: `buildPanelHtml(): string` exported from `scripts/build-panel.ts`. Running the file as main writes `panel/index.html`. The script part is wrapped in `;(function () { 'use strict' … })()`.

Full view is laid out exactly as the spec's Full view list and the mockup's left panel:
- Images come from `../assets/state-<x>.png` relative to `panel/index.html`.
- The timer ticks every 1 s from `activityCard.startMs`, touching only its own node.
- The strip is 30 cells. `null` cells use `#262626`.
- Theme follows `orca.on('theme', …)` when available.
- In this task, switches and the detail control are display-only. Task 3 wires them.

- [ ] **Step 1:** Tests in `test/panel-build.test.ts`:
  - `panel/index.html is up to date` (Review Focus 5): `readFileSync('panel/index.html') === buildPanelHtml()`
  - `built panel has no network or script src`
  - `built panel script runs against a frozen window.orca` (move the existing `node:vm` check here from `entry.test.ts`)
  - `full view renders timeline cells`: run the script in `vm` with a DOM shim (`happy-dom` is not allowed; a minimal shim of the ids used is fine), call the exposed test hook `window.__presencePanel.render(snapshot)` with a 30-slot timeline, and assert 30 cells with the right `data-state` attributes. The hook is exposed only as a non-enumerable property for tests.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the split, the build and the Full view. Delete the old inline-only code paths.
- [ ] **Step 4:** `bun run build && bun test && bun run typecheck && orca plugin validate .`. Expected: pass.
- [ ] **Step 5:** Commit `feat: rebuilt panel Full view from src/panel with inline build`.

### Task 3: Minimal view, view switch, live controls

**Files:** `src/panel/*`, `panel/index.html` (rebuilt), `test/panel-build.test.ts`

**Interfaces:**
- Storage key `panelView`: `'full' | 'minimal'`, read with `orca.host.call('storage.get', { key: 'panelView' })` and written with `storage.set`. Any other value, or an error, means `'full'` (Review Focus 4).
- Controls:
  - Switches map to setting keys: `showAgentState`, `showAgentCount`, `showElapsed`, `showBranch`, `showTerminals`, `showMachine`.
  - The detail control maps to `detailLevel`.
  - Writes use `orca.host.call('settings.set', { key, value })`. On rejection, revert to the last snapshot value and `flash(error.message)` (Review Focus 3).
  - While a write is pending, the control is `aria-busy` and disabled.
- Minimal view follows the spec:
  - The glow colour is a CSS custom property set from the current state.
  - Pulse is disabled under `prefers-reduced-motion`.

- [ ] **Step 1:** Tests (vm + shim):
  - `junk panelView falls back to full`
  - `settings.set rejection reverts switch`: a fake `orca.host.call` rejects; after the click handler settles, `checked` equals the snapshot value and the flash text contains the message
  - `minimal view hides full-only sections`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `bun run build && bun test && bun run typecheck && orca plugin validate .`. Expected: pass.
- [ ] **Step 5:** Commit `feat: panel Minimal view, remembered view switch, live setting controls`.

### Task 4: Cover B and icon

**Files:**
- Create: `scripts/cover/cover.html` (Cover B at 1600×1000, real px values, images via relative `../../assets/…`), `scripts/render-cover.sh`, `assets/cover.png`, `assets/icon.png`
- Modify: `orca-plugin.json` (`"icon": "assets/icon.png"`, `"cover": { "path": "assets/cover.png", "alt": "Rich Presence for Discord: title, the four agent state icons, and a Discord profile card showing Working in Orca" }`), `test/entry.test.ts`

- [ ] **Step 1:** Write `scripts/render-cover.sh`: `google-chrome-stable --headless=new --disable-gpu --hide-scrollbars --window-size=1600,1000 --screenshot=assets/cover.png "file://$PWD/scripts/cover/cover.html"`, then `magick assets/cover.png -strip -define png:compression-level=9 assets/cover.png`. For the icon: `magick assets/orca.png -resize 256x256 -strip assets/icon.png`.
- [ ] **Step 2:** Run it. Check with `identify assets/cover.png assets/icon.png` (expect `1600x1000` and `256x256`) and `du -k` (≤1024 and ≤256). If the cover is too big, convert with `-colors 256` or switch to WEBP, which the cover field also allows.
- [ ] **Step 3:** Add the manifest fields. Add an entry test asserting the icon and cover paths exist and the cover alt is non-empty. Run `orca plugin validate .`. Expected: ok.
- [ ] **Step 4:** Commit `chore: plugin icon and Cover B`.
