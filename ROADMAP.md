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

## Needs Orca host API (in progress on fork)

These are not possible on stock Orca today. Work is in progress on the `jondmarien/orca` fork and is meant for upstream PRs to `stablyai/orca`. Nothing here ships in v1.0.0, and the plugin guards every newer host method with `orca.host.has(name)`.

- **Focus** ([#7](https://github.com/jondmarien/orca-discord-presence/issues/7)): which window, tab, or terminal is focused. Needs a host focus API and event.
- **Client relay**: a host-mediated way to send presence to the Orca client machine, so a remote worker does not need a companion process or an operator-set URL and token.

Until these land, presence is workspace and agent status only.

---

## Not planned without host support

- File-level presence. Orca exposes no active file.
- Machine name of an SSH remote. `os.hostname()` is the machine running the worker.
- Provider priority and rotation. This waits on focus; `src/presence/expiry.ts` already has `isActivityFresh` for it.

---

## Checklist

- [x] Companion bridge, default off, OS-agnostic ([#6](https://github.com/jondmarien/orca-discord-presence/pull/6))
- [x] Clear, opt-in button, configure, multi-agent summary ([#15](https://github.com/jondmarien/orca-discord-presence/issues/15))
- [x] Manifest v2, stock `workspace.*` events and `agents.list`, native settings, bridge token in secrets, panel on `plugin.request` / `panels.post`
- [ ] Listing on onorca.dev
- [ ] Focus (needs Orca host API, in progress on fork) — [#7](https://github.com/jondmarien/orca-discord-presence/issues/7)
- [ ] Client relay (needs Orca host API, in progress on fork)
