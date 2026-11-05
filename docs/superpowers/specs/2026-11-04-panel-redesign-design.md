# Panel redesign + plugin-page cover — design

- **Date:** 2026-11-04 · **Status:** Approved (chat + mockups, 2026-11-04)
- **Parent spec:** `2026-11-04-stock-orca-and-upstream-apis-design.md` (Workstream A). Replaces plan 1 Task 8's cover/icon step and adds the panel work before release.
- **Approved mockup:** `docs/superpowers/specs/mockups/2026-11-04-panel-and-cover.html`. Open it in a browser; it is the visual reference.

## Intent

The current panel works, but it is a plain list of fields. Showcase plugins such as `Etherll/orca-usage-insights` set the bar for sidebar panels. Ours should show at a glance what Discord shows, with polish that matches the listing. The cover gives the onorca.dev page a real hero image instead of drawn fallback art.

## What the author decided

1. **Two panel views.** The header switch reads **Full / Minimal**, and the choice is remembered.
2. **Full view (default)**, in order:
   - header: connection dot, label ("Connected · local" / "Publishing · bridge" / "Disconnected" / "Disabled"), and the view switch
   - **Discord profile card**: a "Playing a game" kicker, the current `state-*` icon (64px), title `Orca`, the details line, the state line, and a green ticking elapsed timer when elapsed is on
   - **Last 30 min** strip with legend
   - two tiles: **Agents** (count plus state-mix bar) and **Sending to** (Local / Bridge / Off, plus the sub-label)
   - **Detail level** segmented control: Off / Generic / Workspace / Full
   - **Agents** list: one row per agent, agent kind on the left and a state chip with time-in-state on the right
   - **Show on Discord** switches: Agent state, Agent count, Elapsed timer, Branch, Terminal count, Machine name
   - actions: Reload, Clear, Pause (= toggle enabled), Status
   - collapsed **Logs** at the bottom
3. **Minimal view**:
   - header
   - **state glow hero**: the radial glow takes the current state's colour, with a pulse dot plus "Live on Discord", a big state word, "N agents · HH:MM:SS", the details line quoted, and the large state icon bleeding off the bottom-right
   - the same **Last 30 min** strip
   - the detail-level control
   - nothing else
4. **Last 30 min appears in both views.** Worker additions to support it are approved.
5. **Cover B**:
   - 1600×1000 canvas, with a dark diagonal gradient from cyan-tinted to neutral to warm
   - on the left: the title "Rich Presence for Discord", the tagline "Workspace and agent state on your Discord profile. Every field opt-in.", and the four state icons in a row
   - on the right: the Discord profile card, with a drop shadow

## Colours (from the author's state icons)

| State | Colour | Chip bg / fg |
| --- | --- | --- |
| working | `#12b8f0` | `rgba(18,184,240,.15)` / `#3fc8f5` |
| waiting | `#f5b800` | `rgba(245,184,0,.15)` / `#f5c23a` |
| blocked | `#e81010` | `rgba(232,16,16,.15)` / `#ff5a5a` |
| idle / done | `#9aa3ad` | `rgba(154,163,173,.15)` / `#b5bcc4` |
| no data | `#262626` (strip only) | — |
| connected dot / timer | `#23a55a` | — |

Neutral surfaces use Orca frame variables with the mockup values as fallbacks: `--orca-background` (#111214), `--orca-card` (#18191b), `--orca-border` (#2a2a2a), `--orca-muted-foreground` (#9a9a9a), `--orca-foreground` (#ececec). Light theme: follow Orca's variables, and keep the state colours. The Discord card keeps its own Discord-dark palette in both themes, because it previews Discord.

## Data contract additions (worker → panel snapshot)

- `timeline: TimelineSlot[]`, exactly 30 entries, oldest first. A slot is one minute holding the highest-priority state seen that minute (`blocked > waiting > working > idle`), or `null` when the worker was not running. *Our call: memory only; it resets when the worker restarts.*
- `agents: { kind: string; state: CanonicalAgentState; sinceMs: number }[]`.
  - `kind` comes from `agents.list`'s `agent` field when that terminal was seeded, else `'agent'`.
  - Never a title, path or terminal id.
- `activity` (already sent as `status.lastActivity`) plus `largeImageKey` / `smallImageKey` and `startTimestamp`, so the card shows the right icon and ticks the timer locally.
- `view` is **not** in the snapshot. The panel reads and writes it in `storage` key `panelView` (`'full' | 'minimal'`, default `'full'`).

## Interaction

- Switches and the detail control write with `window.orca.host.call('settings.set', { key, value })` from the panel. The worker picks the change up through its existing `settings.onDidChange` path, and the next snapshot confirms it. If a write fails, the control reverts and shows the error message.
- Pause / Reload / Clear / Status keep using `plugin.request('presence.run', …)`.
- The timer ticks once a second in the panel from `startTimestamp`. It updates only its own text node; there is no full re-render (see `c6650ec`).
- `prefers-reduced-motion` stops the pulse.

## Constraints

- Everything in `panel/index.html` stays inline: no network, and no `<script src>` (browser clients need this). Images load from plugin-folder relative URLs in the desktop isolated frame. The static "open in desktop app" note stays for browser clients.
- Source moves to `src/panel/{panel.html,panel.css,panel.js}`. `scripts/build-panel.ts` inlines them into `panel/index.html`. A test fails when `panel/index.html` differs from a fresh build.
- No new runtime dependencies. Cover rendering uses headless Chromium at build time only, as a script. The PNG is committed and the script is not shipped.
- Cover: PNG ≤ 1024 KB, 1600×1000. Icon: 256×256 PNG ≤ 256 KB from `assets/orca.png`.

## Left to the builder

Exact spacing and type sizes, within the mockup's look. Copy for empty states ("No agents yet", "Waiting for first update"). How the panel resolves image URLs (relative `../assets/…` from `panel/index.html`).
