# Changelog

All notable changes to this plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.2.1] - 2026-11-26

### Changed

- Split the worker into host, settings, persistence, Discord binding, host synchronization, commands, and panel RPC modules while preserving the v1.2.0 behavior and PR #33 fixes.
- Bundled the sidebar from modular TypeScript and ordered CSS sources into the same single-file panel. The bridge transport and token storage now live under `src/bridge/`.

### Fixed

- Removed duplicate hot-path work and stale caches, coalesced settings and status writes, and disposed panel listeners and timers on shutdown.

## [1.2.0] - 2026-11-26

### Added

- **Custom monochrome panel SVG icon:** Original Orca fin + presence broadcast mark on `contributes.panels[0]` (requires Orca `>=1.4.277`; `engines.orca` bumped to `>=1.4.278`).
- **Draggable / reorderable panel blocks:** Every block inside the panel now has a 6-dot drag handle (pure Pointer Events with midpoint hysteresis, FLIP transitions, scroll-jump protection, `Escape` cancel, and `Alt+ArrowUp`/`Alt+ArrowDown` keyboard reordering with ARIA live announcements). Order persists in `storage:own` and mirrors to a new **Panel section order** setting (`panelOrder`, panel-only), with a subtle **Reset layout** footer button shown when customized.
- **Independent full-width summary cards:** **Agents** and **Sending to** tiles are now independent full-width responsive cards that reorder cleanly anywhere in the panel at every width (`320px`, `240px`, `<180px`).
- **Cross-workspace agent discovery:** Startup and panel Refresh now discover active agents across all workspaces via `workspace.list({ includeStatus: true })` and bounded `agents.list({ workspaceId })` fan-out, and unfocused `agent.status.changed` events resolve agent metadata immediately using `workspaceListId`.
- **Host API 1.5–1.9 signals:** Accurate `mainAgent.stateStartedAt` elapsed timers and local `failure`/`interruption` panel hints; dispatched task titles (`task.title`, local panel only); subtle `Local` / `SSH` / `WSL/VM` host badge in the panel header; `sessionId` fallback slot keys (`s:<sessionId>`) for restored terminals without a `terminalId`; opt-in **Show project name** setting (`showProject`, gated at `workspace`/`full`).
- **Click-to-focus agent rows (`workspace:write`):** Clicking an agent row in the panel jumps straight to its terminal via `terminal.focus` using an opaque worker-side handle.
- **Opt-in Discord session stats (`history:read`):** New **Show session stats** setting (`showSessionStats`: `off`, `tokens`, `messages`, `both`, default `off`) formats compact token/message counts for the active local agent session. `agent.listSessions` is never called while both `showSessionStats` is `off` and `showLeaderboards` is `false`, and `session.title` is discarded immediately on read.
- **Optional Leaderboards panel card (`showLeaderboards`, default `false`):** Local-only workspace table ranking top workspaces by **Messages** or **Tokens** (clickable column headers + proportional progress bars), reorderable and eye-hideable when enabled.
- **Native Save Logs (`orca.files.saveAs`):** New **Save** button in the Logs toolbar exports logs cleanly from isolated desktop frames.

### Changed

- **New permissions:** Added `workspace:write` (used exclusively for click-to-focus agent rows via `terminal.focus`) and `history:read` (used exclusively for opt-in session token/message counts and the optional Leaderboards card; never queried when both are off).
- Panel typography and focus rings follow Orca's live `--orca-font-sans`, `--orca-font-mono`, and `--orca-ring` CSS tokens.
- Updated directory links from `onorca.dev` to `orca.dev` and added a full **Permissions** breakdown in `README.md`.

### Fixed

- Fixed panel live theme switching: `orca.on('theme', ...)` now reads `{ colorScheme }` (Orca's actual payload shape), boots synchronously from `html.light`/`html.dark`, and matches `:root.light`/`:root.dark` in CSS.
- Fixed one-click **Copy** in the Logs viewer inside isolated desktop frames by running `document.execCommand('copy')` synchronously inside the click gesture before falling back to `navigator.clipboard.writeText`.
- `workspace.removed` now cleans up agent slots matching either `workspaceId` or `workspaceListId`.

## [1.1.1] - 2026-11-12

### Changed

- Panel and status bar icons use `bot` instead of `activity`, so the tab no longer collides with other plugins using the activity glyph. (Orca panel icons come from a fixed set; a custom Discord mark is not possible there. See [stablyai/orca#28300](https://github.com/stablyai/orca/issues/28300).)

## [1.1.0] - 2026-11-12

### Added

- Each panel section has an eye button that hides it. Hidden sections are listed in a tray under the header, where you can bring back one section or all of them, and the eye button in the header shows how many are hidden. Your choice is kept across reloads and mirrored to a new **Hidden panels** setting (`hiddenPanels`). Hiding a section never changes what Discord shows and does not undo **Clear**.
- The **Agents** and **Sending to** tiles hide independently, each with its own eye. Hiding one lets the other fill the row.
- The Reload / Clear / Pause / Status row sits under the header tray, above the Discord preview, so it stays reachable.
- In Minimal view the hidden tray only offers the sections Minimal shows (Last 30 min, Detail level); full-only sections stay hidden until you return to Full view.

### Changed

- The panel fits narrow sidebars without scrolling sideways. Header, legend and buttons wrap; tiles stack; below about 240px the legend shows only colours, and below about 180px the tiles become colour bars. Only the Detail level control scrolls, inside itself.
- The panel follows Orca's light and dark theme everywhere, including the Discord preview card, the Minimal view, switches, chips and logs. The last theme is remembered so the panel opens in it.

## [1.0.3] - 2026-11-10

### Fixed

- Presence could stall: the panel showed "Connected · local", but every Discord update timed out. Several sends could start at once and each opened its own connection. Those connections overwrote each other, so handshakes timed out and the live socket was closed. Now only one connection attempt runs at a time.
- Sockets that have been replaced no longer affect the live connection, and closing the client stops a connection attempt that is still retrying. Based on [#28](https://github.com/jondmarien/orca-discord-presence/pull/28) by @meowarex.
- **Reload RPC** during a retry delay now starts a fresh connection instead of waiting for the old attempt to fail.
- Panel **Refresh** no longer fails with `presence.refresh timed out after 5000ms` when Discord is slow. It returns right away, and the Discord update runs in the background.
- A successful **Clear** removes the "updates failing" warning.
- Log paths use the separator of the platform they are built for.

### Added

- The panel shows **Connected · updates failing** (amber) when Discord accepts the connection but does not answer updates. The status bar shows this as not connected.
- `scripts/discord-probe.mjs` (`bun scripts/discord-probe.mjs`) checks every Discord IPC socket the plugin would try and reports whether each one answers.
- `CHANGELOG.md`, `CONTRIBUTING.md`, a pull request template, and bug report and feature request forms.

## [1.0.2] - 2026-11-06

### Added

- The Discord elapsed timer can count the whole Orca work session, and the session survives restarts. New **Elapsed timer counts** setting (`elapsedMode`): the session (default) or the time in the current agent state. A session ends after an idle gap.
- Status bar item that shows the agent state and connection. Clicking it shows or hides the panel. New `showStatusBar` setting.

### Changed

- Because of the status bar item, Orca keeps the plugin worker running while the plugin is enabled.

### Fixed

- The status bar click toggles the sidebar declaratively.

## [1.0.1] - 2026-11-04

### Changed

- Smaller plugin images for the directory listing.
- Releases run only on `vX.Y.Z` tags, under the new plugin identity.

## [1.0.0] - 2026-11-04

First release for stock Orca (`>=1.4.248`), listed on [orca.dev](https://orca.dev/plugins/jondmarien/orca-discord-presence).

### Changed

- **Breaking:** manifest v2 and a new identity, `jondmarien.discord-presence` (was `chron0.discord-presence`). Old settings do not carry over.
- Uses stock Orca workspace events and `agents.list`, so no Orca fork is needed. Agent slots are keyed by terminal.
- Settings moved to Orca's native Settings page.
- The companion bridge token is stored in plugin secrets, and never falls back to plaintext when a keyring exists.
- Discord small images use bare state keys (`working`, `completed`, ...) with `-v2` asset keys, so the redesigned icons bypass Discord's image cache.

### Added

- Rebuilt panel with a Full view and a Minimal view (your choice is remembered) and live setting controls. The panel talks to the worker over `plugin.request` and `panels.post`.
- 30-minute state timeline that shows every agent state present in each minute. It survives worker restarts.
- Agent list with chat names (long names scroll), time in state, and a completed icon.
- `completed` agent state, separate from idle. Completed agents stay listed for 10 minutes.
- Choose which running Discord client receives presence, from a dropdown of detected clients.
- Panel **Refresh** button that forces a full update.
- New plugin icon, cover and state images.

### Fixed

- Unknown agent states read as idle, not completed.
- The agent kind is looked up for agents started after activation, and re-synced on focus change.
- Focusing nothing clears the old workspace from presence.
- A Discord client you chose that starts later takes over from the fallback.
- The same socket index in two locations no longer collides.
- A **Clear** hold survives controller rebuilds and is released by the next agent event or settings change.
- Long-running and recently finished agents keep their state across restarts.
- The panel updates only changed nodes and keeps the log scroll position.

[1.0.3]: https://github.com/jondmarien/orca-discord-presence/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/jondmarien/orca-discord-presence/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jondmarien/orca-discord-presence/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jondmarien/orca-discord-presence/releases/tag/v1.0.0
