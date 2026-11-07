# Session Timer and Status Bar Item Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo, workers are Orca orchestration **terminal** agents (Claude Sonnet 5.5).

**Goal:** The Discord elapsed timer counts the whole Orca work session (persisted across restarts) instead of the current agent state. A status bar item shows presence state and keeps the worker resident. Ships as v1.0.2.

**Architecture:** A pure session clock (`src/presence/session.ts`) is touched by real activity and persisted to plugin storage. `buildActivity` picks the session or state start by a new `elapsedMode` setting. A pure renderer (`src/presence/status-bar.ts`) turns status, settings and summary into a `statusBar.update` patch, which `main.ts` sends only when it changes.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun build`), `tsc --noEmit`, Orca plugin host API 1.2+ (`statusBar.update`, `commands.run`, `storage.*`).

**Spec:** `docs/superpowers/specs/2026-11-06-session-timer-and-status-bar-design.md`

## Global Constraints

- `engines.orca` stays `>=1.4.248`; manifest stays v2 `trusted-worker`.
- Every newer host method is guarded with `orca.host.has(name)`: `statusBar.update`, `commands.run`, `storage.get`, `storage.set`.
- `SESSION_GAP_MS = 30 * 60_000`. Storage key `session`. Heartbeat (`HEARTBEAT_MS = 90_000`) never counts as activity.
- `elapsedMode`: enum `session` | `state`, default `session`. Labels: "Time in Orca this session", "Time in the current agent state".
- `showStatusBar`: boolean, default `true`.
- `showElapsed` description becomes "Show an elapsed timer on Discord."
- Status bar item id `presence`; command `presence.open-panel`, title "Rich Presence: Show or Hide Panel".
- The status bar never shows more than the Discord card. Tooltip details come from the already privacy-gated `lastActivity.details`.
- Comments: one line, `Why:` style. Tests: few and meaningful.
- Version `1.0.2` in `package.json`, `orca-plugin.json`, `src/version.ts`, and the README badge.
- Plugin repo only. `bun test` / `bun run typecheck` / `bun run build` are safe on the Linux laptop. Never run upstream Orca checks.

## Review Focus

1. **Orca restarted inside the gap:** the timer keeps its old start. Test: Task 1 `restore inside gap keeps start`.
2. **Orca left open overnight with no work:** the heartbeat does not extend the session, so the next activity starts a new one. Test: Task 1 `touch after gap restarts`. Task 4 Step 2 keeps `touch` off the heartbeat path; manual check 3–4.
3. **Corrupt or foreign storage value** (string, missing fields, `lastActiveMs` in the future): ignored, fresh session, no throw. Test: Task 1 `restore ignores bad input`.
4. **Presence disabled, `detailLevel: 'off'`, or a Clear hold:** status bar reads `Discord off`, and the tooltip carries no workspace name. Test: Task 3 table rows.
5. **Host without `statusBar.update`** (browser or paired client): no call and no error. Covered by the guard in Task 4 plus a manual check.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/presence/session.ts` (new) | Pure session clock: touch, start, gap, JSON round-trip |
| `src/presence/expiry.ts` | Add `SESSION_GAP_MS` |
| `src/presence/settings.ts`, `orca-plugin.json` | `elapsedMode`, `showStatusBar` settings; status bar item and command |
| `src/presence/activity.ts` | `sessionStartMs` on snapshot; pick timer start by mode |
| `src/presence/status-bar.ts` (new) | Pure status bar patch renderer and duration formatter |
| `src/main.ts` | Wire clock, persistence, status bar updates, open-panel command |
| `docs/architecture.md`, `README.md`, `ROADMAP.md`, version files, `dist/` | Release 1.0.2 |

---

### Task 1: Session clock

**Files:**
- Create: `src/presence/session.ts`
- Modify: `src/presence/expiry.ts` (add the constant next to `AGENT_RETENTION_MS`)
- Test: `test/presence-session.test.ts`

**Interfaces:**
- Produces:
  - `export const SESSION_GAP_MS = 1_800_000` in `expiry.ts`
  - `export type SessionJSON = { startMs: number; lastActiveMs: number }`
  - `export function createSessionClock(options: { gapMs?: number; now?: () => number }): SessionClock`
  - `SessionClock = { touch(): void; startMs(): number | undefined; restore(value: unknown): void; toJSON(): SessionJSON | null }`

- [ ] **Step 1: Write failing tests** in `test/presence-session.test.ts`. Use the `harness` style from `test/presence-timeline.test.ts` (an injected `now`, `advance(ms)`), with `MINUTE = 60_000` and `gapMs` = `SESSION_GAP_MS`:
  - `startMs undefined before first touch`; `toJSON()` is `null`.
  - `first touch starts a session`: touch at T, so `startMs() === T`.
  - `touch inside gap keeps start`: touch at T, advance 29 min, touch, so `startMs() === T`. Advance another 29 min, touch, so still T (the gap is measured from the last touch).
  - `touch after gap restarts`: touch at T, advance 31 min, touch, so `startMs() === T + 31 * MINUTE`.
  - `time without touch does not extend`: touch at T, advance 31 min without touching, so `startMs()` is still T (the start is only replaced on the next touch).
  - `restore inside gap keeps start`: `restore({ startMs: T - 2h, lastActiveMs: T - 10 * MINUTE })` with now T, then touch, so `startMs() === T - 2h`.
  - `restore outside gap is dropped`: `restore({ startMs: T - 2h, lastActiveMs: T - 40 * MINUTE })`, so `startMs()` is undefined; touch, so T.
  - `restore ignores bad input`: for each of `null`, `'x'`, `{}`, `{ startMs: 'a', lastActiveMs: 1 }`, `{ startMs: T, lastActiveMs: T + 5 * MINUTE }` (future), `{ startMs: T + 1, lastActiveMs: T }` (start after last active), restore leaves `startMs()` undefined and does not throw.
  - `toJSON round-trips`: after touch, `createSessionClock(...).restore(clock.toJSON())` gives the same `startMs()`.

- [ ] **Step 2: Run tests, verify they fail**
  Run: `bun test test/presence-session.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createSessionClock`** in `src/presence/session.ts`. Keep two numbers in a closure. `touch` starts a new session when there is none or `now - lastActiveMs > gapMs`, and always sets `lastActiveMs = now`. `restore` accepts only finite numbers with `startMs <= lastActiveMs <= now` and `now - lastActiveMs <= gapMs`. Add a one-line module doc comment.

- [ ] **Step 4: Run tests, verify they pass**
  Run: `bun test test/presence-session.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add src/presence/session.ts src/presence/expiry.ts test/presence-session.test.ts && git commit -m "feat(presence): session clock for the elapsed timer"`

---

### Task 2: Settings and manifest

**Files:**
- Modify: `src/presence/settings.ts` (`PresenceSettings`, `DEFAULT_SETTINGS`, `normalizeSettings`)
- Modify: `orca-plugin.json` (`contributes.settings`, `contributes.commands`, new `contributes.statusBarItems`)
- Test: `test/presence-settings.test.ts`

**Interfaces:**
- Produces:
  - `export const ELAPSED_MODES = ['session', 'state'] as const; export type ElapsedMode = (typeof ELAPSED_MODES)[number]`
  - `PresenceSettings.elapsedMode: ElapsedMode` (default `'session'`)
  - `PresenceSettings.showStatusBar: boolean` (default `true`)

- [ ] **Step 1: Write failing tests** in `test/presence-settings.test.ts`:
  - `elapsedMode defaults to session`: `normalizeSettings({}).elapsedMode === 'session'`.
  - `elapsedMode accepts state, rejects unknown`: `'state'` gives `'state'`; `'bogus'` and `3` give `'session'`.
  - `showStatusBar defaults true and is a toggle field`: default `true`; `toggleField(DEFAULT_SETTINGS, 'showStatusBar').showStatusBar === false`.
  - `manifest declares every setting key`: if the existing test already compares `SETTING_KEYS_DECLARED` with the manifest, it now fails until the manifest is updated. Otherwise add that comparison for the two new keys.

- [ ] **Step 2: Run tests, verify they fail**
  Run: `bun test test/presence-settings.test.ts`
  Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement.**
  - In `settings.ts`, add both fields with one-line doc comments. Normalize `elapsedMode` the same way `detailLevel` is (unknown keeps the default). `showStatusBar` is picked up by the existing boolean handling.
  - In `orca-plugin.json` `contributes.settings`, add `elapsedMode` right after `showElapsed`:
    - `type: "string"`, `enum: ["session","state"]`, `enumLabels: ["Time in Orca this session","Time in the current agent state"]`, `default: "session"`
    - title "Elapsed timer counts"
    - description "Session counts while you work in Orca and resets after 30 minutes with no activity."
  - Add `showStatusBar`: title "Show status bar item", description "Show presence state in Orca's status bar.", `default: true`.
  - Change the `showElapsed` description to "Show an elapsed timer on Discord."
  - Add command `{ "id": "presence.open-panel", "title": "Rich Presence: Show or Hide Panel" }`.
  - Add `"statusBarItems": [{ "id": "presence", "text": "Discord", "icon": "activity", "tooltip": "Rich Presence for Discord", "command": "presence.open-panel" }]`.

- [ ] **Step 4: Run tests, verify they pass**
  Run: `bun test test/presence-settings.test.ts && bun run typecheck`
  Expected: PASS, no type errors.

- [ ] **Step 5: Commit**
  `git add src/presence/settings.ts orca-plugin.json test/presence-settings.test.ts && git commit -m "feat(settings): elapsedMode and showStatusBar"`

---

### Task 3: Activity timer start and status bar renderer

**Files:**
- Modify: `src/presence/activity.ts` (snapshot type plus the `timestamps` block at about line 223)
- Create: `src/presence/status-bar.ts`
- Test: `test/presence-activity.test.ts`, `test/presence-status-bar.test.ts` (new)

**Interfaces:**
- Consumes: `ElapsedMode` (Task 2); `PresenceStatus`, `DiscordActivity` (existing); `CanonicalAgentState` from `agent-state.ts`.
- Produces:
  - `PresenceSnapshot.sessionStartMs?: number`
  - `export function elapsedStartMs(snapshot: PresenceSnapshot, settings: PresenceSettings): number | undefined`. Returns `sessionStartMs` for `'session'` and `stateStartedAtMs` for `'state'`. `buildActivity` uses it.
  - `export type StatusBarPatch = { id: 'presence'; text: string; icon: 'activity' | 'warning'; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip: string; visible: boolean }`
  - `export function renderStatusBar(input: { status: PresenceStatus; settings: PresenceSettings; agentState?: CanonicalAgentState; agentCount: number; elapsedStartMs?: number; nowMs: number }): StatusBarPatch`
  - `export function formatDuration(ms: number): string`

- [ ] **Step 1: Write failing tests.**

  `presence-activity.test.ts`:
  - `session mode uses sessionStartMs`: snapshot `{ stateStartedAtMs: B, sessionStartMs: A }` with `elapsedMode: 'session'` gives `timestamps.start === Math.floor(A / 1000)`.
  - `state mode uses stateStartedAtMs`: same snapshot with `'state'` gives `Math.floor(B / 1000)`.
  - `session mode without a session omits timestamps`: no `sessionStartMs`, so `timestamps` is undefined.
  - The existing `showElapsed: false` test stays green unchanged.

  `presence-status-bar.test.ts`: one `test.each` table over `renderStatusBar`, with defaults `enabled: true`, `connected: true`, `heldClear: false`, `detailLevel: 'workspace'`, `showAgentState: true`, `showAgentCount: true`, `showStatusBar: true`, `lastActivity.details: 'Working on orca'`:

  | Case | Input change | text | tone | icon |
  |---|---|---|---|---|
  | working, 1 agent | `agentState: 'working', agentCount: 1` | `Working` | `accent` | `activity` |
  | working, 3 agents | `agentCount: 3` | `Working · 3` | `accent` | `activity` |
  | 3 agents, count hidden | `showAgentCount: false` | `Working` | `accent` | `activity` |
  | blocked | `'blocked'` | `Blocked` | `danger` | `activity` |
  | waiting | `'waiting'` | `Waiting` | `warning` | `activity` |
  | done | `'done'` | `Done` | `success` | `activity` |
  | idle, connected | no agentState | `Discord` | `neutral` | `activity` |
  | state hidden | `showAgentState: false, 'working'` | `Discord` | `neutral` | `activity` |
  | disabled | `status.enabled: false` | `Discord off` | `neutral` | `activity` |
  | detail off | `detailLevel: 'off'` | `Discord off` | `neutral` | `activity` |
  | clear hold | `heldClear: true` | `Discord off` | `neutral` | `activity` |
  | not connected | `connected: false, sink: null` | `Discord` | `warning` | `warning` |
  | via bridge | `connected: false, sink: 'bridge'` | (agent text) | (agent tone) | `activity` |

  Further tests in the same file:
  - **Tooltip:** working with `elapsedStartMs = now - (2h 14m)` gives exactly `Discord: Working on orca · 2h 14m · connected via local. Click to show or hide the panel.`
  - **Tooltip when off:** the `Discord off` rows give `Discord: off. Click to show or hide the panel.` with no `details`.
  - **Tooltip when not connected:** the line ends `· not connected. Click to show or hide the panel.`
  - **Hidden:** `showStatusBar: false` gives `visible: false`.
  - **`formatDuration`:** `0` and `59_000` give `<1m`; `14 * 60_000` gives `14m`; `(2 * 60 + 14) * 60_000` gives `2h 14m`; `3 * 3_600_000` gives `3h 0m`.

- [ ] **Step 2: Run tests, verify they fail**
  Run: `bun test test/presence-activity.test.ts test/presence-status-bar.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In `activity.ts`, add `sessionStartMs` to the snapshot type and add `elapsedStartMs`. Replace the `typeof snapshot.stateStartedAtMs === 'number'` check with `elapsedStartMs(...)`, and keep the `Math.min(…, nowMs)` clamp.
  - In `status-bar.ts`, follow the table:
    - "Off" means `!status.enabled || status.heldClear || settings.detailLevel === 'off'`.
    - "Not connected" means `!status.connected && status.sink !== 'bridge'`.
    - The tooltip time part is omitted when `elapsedStartMs` is undefined or `showElapsed` is false.
    - Use `status.lastActivity?.details`. Never read a workspace name or branch directly.

- [ ] **Step 4: Run tests, verify they pass**
  Run: `bun test && bun run typecheck`
  Expected: all PASS.

- [ ] **Step 5: Commit**
  `git add src/presence/activity.ts src/presence/status-bar.ts test/presence-activity.test.ts test/presence-status-bar.test.ts && git commit -m "feat(presence): session-based timer start and status bar renderer"`

---

### Task 4: Wire into the worker

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `createSessionClock`, `SESSION_GAP_MS` (Task 1); `renderStatusBar`, `elapsedStartMs` (Task 3); settings (Task 2).

- [ ] **Step 1: Session clock lifecycle.**
  - Module state: `let session: SessionClock | null`. Add `SESSION_STORAGE_KEY = 'session'` next to `TIMELINE_STORAGE_KEY`.
  - In `activate`, next to the timeline restore (about line 470), guarded by `has('storage.get')`: `session = createSessionClock({ gapMs: SESSION_GAP_MS })`, then `session.restore(stored?.value)`.
  - Persist with the timeline write: extend `persistTimeline` (rename it `persistState`) so the one 15 s debounced flush also writes `SESSION_STORAGE_KEY`. Do the same in `deactivate`.

- [ ] **Step 2: Touch only on real activity.**
  - In `refresh`, call `session?.touch()` when any of these holds: `agentEvent` is set; `options.context !== undefined` (a `workspace.changed`); or `summary.agentCount > 0`.
  - Call `session?.touch()` in the `presence.snapshot` and `presence.refresh` panel handlers.
  - The heartbeat calls `refresh(undefined, { force: true })` with no event or context, so it touches only while agents are listed. That is intended: agents are dropped from the list after their retention window.
  - Pass `sessionStartMs: session?.startMs()` in the `controller.update` snapshot.

- [ ] **Step 3: Status bar updates.**
  - Add `let lastStatusBar: string | null = null` and `function publishStatusBar()`. It returns early unless `orca.host.has('statusBar.update')`. It builds the patch with `renderStatusBar({ status: controller.status(), settings: controller.settings(), agentState, agentCount, elapsedStartMs: elapsedStartMs(snapshot, settings), nowMs: Date.now() })` from the latest summary and session. When `JSON.stringify(patch) !== lastStatusBar`, it calls `orca.host.call('statusBar.update', patch).catch(() => {})` and stores the string.
  - Call it at the end of `refresh` and after `applySettings`. The heartbeat refresh covers the tooltip time.
  - Save the host reference with the existing `timelineHost` (rename it `stateHost` if that reads better).

- [ ] **Step 4: Open-panel command.**
  `registerPalette('presence.open-panel', …)`:
  - When `orca.host.has('commands.run')`, call `commands.run` with `{ action: 'sidebar.right.toggle' }`.
  - Otherwise, run the same handler as `presence.status`.

- [ ] **Step 5: Verify**
  Run: `bun test && bun run typecheck && bun run build`
  Expected: all PASS, and `dist/main.js` rebuilt.

- [ ] **Step 6: Manual check (maintainer, Linux desktop with Vesktop).** Dev-load with `orca plugin dev` or the existing dev link, then confirm:
  1. A status bar item appears; its text and tone follow agent state.
  2. Clicking it toggles the sidebar holding the Rich Presence panel. If `sidebar.right.toggle` is the wrong sidebar, try the other `sidebar.*` actions from the `commands.run` enum. If none fits, keep the `presence.status` fallback as the only click path and note that in the commit.
  3. Discord's timer keeps counting through a working → waiting → working change.
  4. Restart Orca, and Discord's timer keeps its earlier start.
  5. Turning `showStatusBar` off hides the item.

- [ ] **Step 7: Commit**
  `git add src/main.ts dist/main.js && git commit -m "feat: session timer persistence and status bar item"`

---

### Task 5: Docs and release 1.0.2

**Files:**
- Modify: `package.json`, `orca-plugin.json`, `src/version.ts`, `README.md` (badge and the settings/feature list), `docs/architecture.md`, `ROADMAP.md` (tick the "Session elapsed timer and status bar item" checklist line), `dist/main.js`

- [ ] **Step 1:** Bump the version to `1.0.2` in the four version sites. Edit only the README version badge, then add `elapsedMode`, `showStatusBar` and the status bar item to the README's settings or features list.
- [ ] **Step 2:** Add a short paragraph to `docs/architecture.md`:
  - The session clock and storage key `session`.
  - The status bar item.
  - That a status bar item makes Orca keep the worker resident, so it is never idle-reaped.
- [ ] **Step 3:** Run `bun test && bun run typecheck && bun run build`. Expected: PASS. `grep -c 1.0.2 package.json orca-plugin.json src/version.ts` gives 1 each.
- [ ] **Step 4:** Commit with `chore: release 1.0.2`. Pushing, the PR and the `v1.0.2` tag need the maintainer's OK. The release workflow runs only on the tag.
