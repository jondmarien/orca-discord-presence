# Session timer and status bar item

Author: Jonathan Marien
Date: 2026-11-06
Status: approved 2026-11-06

## Why

A user reported that the Discord "elapsed" timer never passes about an hour, even after 6 hours of work in Orca. The maintainer sees the same thing while developing.

**Root cause (confirmed in code, not a dropped connection).** `timestamps.start` comes from `summarizeSlots` in `src/presence/agents.ts`. It is the start of the *current strongest agent state*, so it moves when:

- the strongest state changes (working, then waiting, then working again), or a new agent starts working after another finishes;
- every agent slot is dropped (`done` after 10 min, stale after 30 min), which removes `timestamps` entirely, and the next agent starts it again from zero.

In real use one of these happens well within an hour, so the timer looks like it "restarts randomly".

**Connection theory, checked.** Discord has no one-hour Rich Presence timeout (discord/discord-rpc#121, a 2018 server-side issue since fixed). Orca reaps idle plugin workers after 5 minutes (`PLUGIN_WORKER_IDLE_REAP_MS`), but our 90 s heartbeat keeps the worker active, and the local log shows the heartbeat running for over a day without a gap. A real drop would show as a mid-session `discord.connect_ok` in `orca plugin logs jondmarien.discord-presence`. The status bar item below makes the worker resident anyway, which removes reaping as a cause.

A second request asked for a footer (status bar) indicator, like the usage-insights plugin's "35.2M today" item.

## Goals

1. By default the Discord timer shows how long you have been working in Orca this session, and survives worker restarts.
2. The old behaviour (time in the current agent state) stays available as an option.
3. A status bar item shows the presence state at a glance and opens the Rich Presence panel on click.
4. The worker stays resident while the plugin is enabled (a side effect of 3).

## Non-goals

- Gutter icons or hovers in the source editor. Needs a new Orca host API; tracked in `ROADMAP.md`.
- Beating Discord's 24-hour wrap of the elapsed display. That is a Discord limit.
- Focus-based "actively typing" detection. Waits on upstream `ui:focus` (stablyai/orca#38415).

## Anti-goals

- The timer must not reset while you are still working, including across Orca or worker restarts inside the gap.
- The status bar item must not leak more than the Discord card shows. It follows the same privacy settings (detail level, branch, and so on).
- No extra host calls on a hot path. The status bar updates only when its text, tone or tooltip changes.

## Design

### 1. Session timer

New pure module `src/presence/session.ts`:

```ts
createSessionClock({ gapMs, now }) => {
  touch(): void                 // activity seen now
  startMs(): number | undefined // undefined before the first touch
  restore(json): void           // { startMs, lastActiveMs }
  toJSON(): { startMs, lastActiveMs } | null
}
```

- **Activity** is any of: an agent slot present at refresh, a `workspace.changed` event, an `agent.status.changed` event, or a panel request (`presence.snapshot` / `presence.refresh`).
- **Session start:** the first `touch()`. When the time since `lastActiveMs` is more than `gapMs` at the next `touch()`, a new session starts at that moment.
- **Gap:** `SESSION_GAP_MS = 30 * 60_000`, in `src/presence/expiry.ts` next to the other windows (my call: it matches the existing stale-agent window).
- **Persistence:** storage key `session`, saved with the same debounce helper as `timeline`, and saved on `stop`. On worker start, `restore` keeps the session only when `now - lastActiveMs <= gapMs`.
- **Heartbeat:** the 90 s heartbeat does not count as activity. Otherwise the session never ends while Orca is open.

New setting in `orca-plugin.json` and `src/presence/settings.ts`:

| Key | Type | Default | Values |
|---|---|---|---|
| `elapsedMode` | enum | `session` | `session` ("Time in Orca this session"), `state` ("Time in the current agent state") |

`showElapsed` stays the on/off switch. Its description changes to "Show an elapsed timer on Discord." Existing installs pick up the new default (my call: the old behaviour is what the bug report is about).

`buildActivity` gets `sessionStartMs` on the snapshot. With `elapsedMode: 'session'` it uses that. With `'state'` it uses `stateStartedAtMs` as today. Keep the `Math.min(…, nowMs)` clamp.

The panel hero timer follows the same setting (my call, so the panel and Discord agree). Per-agent time chips in the agent list stay per agent.

### 2. Status bar item

Manifest:

```json
"statusBarItems": [
  { "id": "presence", "text": "Discord", "icon": "activity", "tooltip": "Rich Presence for Discord", "command": "presence.open-panel" }
]
```

New command `presence.open-panel`, titled "Rich Presence: Show or Hide Panel". It calls `commands.run` with the action that toggles the sidebar holding plugin panels, guarded by `orca.host.has('commands.run')`. Otherwise it falls back to the `presence.status` handler.

The worker calls `statusBar.update` (guarded by `orca.host.has('statusBar.update')`) from the same place that publishes the panel snapshot, and only when the rendered `{ text, icon, tone, tooltip, visible }` differs from the last one sent.

| Presence | `text` | `tone` |
|---|---|---|
| Working | `Working` (`Working · 3` with more than one agent, when agent count is shown) | `accent` |
| Blocked | `Blocked` | `danger` |
| Waiting / question | `Waiting` | `warning` |
| Completed | `Done` | `success` |
| Idle, connected | `Discord` | `neutral` |
| Disabled or Clear hold | `Discord off` | `neutral` |
| Not connected to Discord or bridge | `Discord` with icon `warning` | `warning` |

Tooltip: `Discord: <details line> · <session or state elapsed, e.g. 2h 14m> · <connected via local | bridge | not connected>. Click to show or hide the panel.` It is refreshed by the heartbeat, so the time is at most 90 s stale. The status bar does not tick by itself.

New setting `showStatusBar` (boolean, default `true`). When false, send `visible: false`.

### 3. Resident worker (bonus)

Upstream `pluginNeedsResidentWorker` keeps any plugin that has `main` and `statusBarItems` warm, so it is never idle-reaped. No code needed. Note it in `docs/architecture.md`.

## Constraints

- `engines.orca` stays `>=1.4.248`, since `statusBarItems` and `statusBar.update` are both 1.4.248.
- Desktop only for the status bar. Paired and browser clients get `has('statusBar.update') === false`, so they skip it.
- Plugin repo tooling only (Bun, about 300 tests). Safe on the Linux laptop. No upstream Orca checks.
- Follow the existing style: one-line `Why:` comments and a few meaningful tests.

## Testing

- `test/presence-session.test.ts`: first touch starts a session; a touch inside the gap keeps the start; a touch after the gap restarts; restore inside or outside the gap; heartbeat-only time does not extend.
- `test/presence-activity.test.ts`: `elapsedMode` session vs state picks the right start; the `showElapsed: false` path is unchanged.
- Status bar render function (pure, in `src/presence/status-bar.ts`): one table-driven test over the rows above, plus "no update when unchanged".
- Manual: dev-load, work through a state change, and confirm the Discord timer keeps counting. Restart Orca within 30 minutes and confirm it keeps counting. Check the status bar item text and tone, and that clicking it opens the panel.

## Left to the builder

- Which `commands.run` action reveals the sidebar where Orca shows plugin panels (`sidebar.right.toggle` is the likely one). Confirm in a dev run. If no action fits, keep the `presence.status` fallback as the click.
- Exact tooltip wording within the shape above.
- Whether `presence.toggle-elapsed` should also get a palette command to switch `elapsedMode` (optional).

## Release

Ships as 1.0.2 (decided 2026-11-06). 1.1.0 stays reserved for the question state.
