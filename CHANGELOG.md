# Changelog

All notable changes to this plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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

First release for stock Orca (`>=1.4.248`), listed on [onorca.dev](https://www.onorca.dev/plugins/jondmarien/orca-discord-presence).

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
