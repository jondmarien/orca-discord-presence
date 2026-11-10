# Roadmap

Author: Jonathan Marien  
Date: 2026-11-04

Known limits of `jondmarien.discord-presence` on stock Orca, and the Orca host work that would lift them. This is not a schedule.

See also [README](README.md), [Architecture](docs/architecture.md), [Privacy](docs/privacy.md).

---

## Where presence runs

Paired Orca clients and `orca serve` run plugins on the host, not on the client. The worker publishes to Discord over local IPC when Discord is on the same machine. Otherwise it posts to the [companion](companion/README.md) on the machine that has Discord.

| Setup | Worker runs on | Discord path |
|---|---|---|
| Local desktop | That desktop | Local IPC |
| Linux host with Vesktop, controlled from another machine | Linux host | Local IPC on the host |
| Linux host, Discord on Windows | Linux host | Companion on Windows |
| `orca serve` on an SSH server | SSH server | Companion next to Discord |

Setup and smoke tests:

- **Local IPC:** Discord signed in on the machine running the worker. **Rich Presence: Show Status** reports `connected=true`.
- **Companion:** `bun run companion` on the Discord machine (from source; a binary is optional and local only), then Bridge URL in Orca Settings and `bridgeToken` through **Rich Presence: Configure**. Show Status reports `connected=false sink=bridge` when the worker's machine has no Discord.

The companion is the supported remote path on stock Orca. It needs no Orca changes.

---

## Needs Orca host API (upstream)

These are not possible on stock Orca today. Each one has an issue on `stablyai/orca`, and PRs follow once maintainers weigh in. The plugin guards every newer host method with `orca.host.has(name)`.

| Feature | Upstream issue | Upstream PR | Status |
|---|---|---|---|
| **Agent prompt kind**: tell a question apart from other waits (question state) | [#38340](https://github.com/stablyai/orca/issues/38340) | [#38406](https://github.com/stablyai/orca/pull/38406) | PR open, awaiting review |
| **UI focus** (`ui:focus`): which kind of tab is focused ([#7](https://github.com/jondmarien/orca-discord-presence/issues/7)) | [#38341](https://github.com/stablyai/orca/issues/38341) | [#38415](https://github.com/stablyai/orca/pull/38415) | PR open, awaiting review |
| **Paired panels**: show the host's plugin panels in paired desktop clients | [#38342](https://github.com/stablyai/orca/issues/38342) | — | Waiting on maintainer comment |
| **Client relay**: send presence from a host worker to the same plugin on a paired client, without a companion or operator-set URL and token | [#38343](https://github.com/stablyai/orca/issues/38343) | — | Waiting on maintainer comment |

The earlier combined PR [#19023](https://github.com/stablyai/orca/pull/19023) is closed; the focused issues and PRs above replace it.

Until these land, presence is workspace and agent status only.

---

## Not planned without host support

- File-level presence. Orca exposes no active file.
- Machine name of an SSH remote. `os.hostname()` is the machine running the worker.
- Provider priority and rotation. This waits on focus; `src/presence/expiry.ts` already has `isActivityFresh` for it.
- Gutter icon with a hover message in the source editor (a clickable mark on a line that shows a hover-style message). Orca's editor is Monaco, which supports this (glyph-margin decorations with a hover message and `onMouseDown`), but the plugin host API has no editor decoration or hover API; plugins only get `editor.open` and custom editors. Needs a new upstream Orca API, which has no issue filed yet. Community request, 2026-11-06.

---

## Next release: 1.1.0

Once [stablyai/orca#38406](https://github.com/stablyai/orca/pull/38406) merges and ships in an Orca release, build 1.1.0: the question state plus the held Minimal-view screenshot on `jondmarien/minimal-shot`.

---

## Checklist

- [x] Companion bridge, default off, OS-agnostic ([#6](https://github.com/jondmarien/orca-discord-presence/pull/6))
- [x] Clear, opt-in button, configure, multi-agent summary ([#15](https://github.com/jondmarien/orca-discord-presence/issues/15))
- [x] Manifest v2, stock `workspace.*` events and `agents.list`, native settings, bridge token in secrets, panel on `plugin.request` / `panels.post`
- [x] Listing on onorca.dev
- [ ] Question state (needs [stablyai/orca#38406](https://github.com/stablyai/orca/pull/38406)), ships in 1.1.0
- [ ] Focus (needs [stablyai/orca#38415](https://github.com/stablyai/orca/pull/38415)) — [#7](https://github.com/jondmarien/orca-discord-presence/issues/7)
- [ ] Paired panels (needs [stablyai/orca#38342](https://github.com/stablyai/orca/issues/38342))
- [ ] Client relay (needs [stablyai/orca#38343](https://github.com/stablyai/orca/issues/38343))
- [x] Session elapsed timer and status bar item (v1.0.2) (spec: `docs/superpowers/specs/2026-11-06-session-timer-and-status-bar-design.md`)
- [x] Fix overlapping Discord connects that stalled SET_ACTIVITY; non-blocking panel Refresh; "updates failing" state (v1.0.3)
- [ ] Editor gutter icon with hover (needs a new Orca editor decoration API; no upstream issue yet)
