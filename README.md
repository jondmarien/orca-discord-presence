<div align="center">

<img src="assets/orca.png" width="96" alt="Shipped Discord Rich Presence large asset (orca)" />

# Discord Rich Presence for Orca

**Workspace, branch, and agent state on your Discord profile — every identifying field is opt-in.**

[![Version](https://img.shields.io/badge/v0.3.0-blue.svg)](orca-plugin.json)
[![Orca plugin](https://img.shields.io/badge/Orca-chron0.discord--presence-5c6bc0)](orca-plugin.json)
[![Bun](https://img.shields.io/badge/Bun-1.4+-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Discord RPC](https://img.shields.io/badge/Discord-Rich_Presence-5865F2?logo=discord&logoColor=white)](docs/architecture.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`chron0.discord-presence` · publisher `chron0` · id `discord-presence` (do not rename) · Orca `>=1.4.0`

</div>

Default Discord copy is **`Working in Orca`** plus optional agent state and an elapsed timer. Repo, branch, and machine names stay off until you raise the detail level. You do **not** need your own Discord application — the plugin ships Application ID `1545653843239374848` (public snowflake; no bot token, no client secret).

Browser Discord has **no** IPC socket. Presence needs the **desktop** client (Discord, Vesktop + arRPC, or Vencord-with-RPC) on the Orca host **or** on a [companion](#dual-host-companion).

---

## What is this?

A trusted Orca plugin worker (`dist/main.js`) that publishes privacy-gated Rich Presence. Orca loads Node/Electron-compatible ESM — Bun is only for authoring and tests.

| | |
|---|---|
| Qualified id | `chron0.discord-presence` |
| What Discord shows (default) | Game `Orca` · `Working in Orca` · agent label · elapsed timer · `orca` / `state-*` art |
| What it reads | `agent.status.changed`, `workspace.readContext` (name, branch, terminal **count**), worktree events, 90 s heartbeat |
| What it does **not** read | Focused window / tab / file — see [#7](https://github.com/jondmarien/orca-discord-presence/issues/7) |
| Discord path | Local IPC first; opt-in HTTP companion if Discord is on another machine ([#6](https://github.com/jondmarien/orca-discord-presence/pull/6)) |
| Settings UI | Command palette only in v0.3 (no settings panel) |

---

## Presence look

Every non-null activity uses large image `orca` (`large_text`: `Orca`) plus one small `state-*` overlay from [`src/presence/activity.ts`](src/presence/activity.ts) (`AGENT_STATE_LABELS`). Previews are the in-repo PNGs already uploaded to the shipped Discord application. Live Discord profile screenshots can be added later — no extra states, no invented URLs.

| State | Asset key | Meaning | Preview |
|---|---|---|---|
| *(always)* | `orca` | Large image on every activity | <img src="assets/orca.png" width="64" alt="Asset key orca" /> |
| `working` | `state-working` | Small image · `small_text` `working` | <img src="assets/state-working.png" width="48" alt="Asset key state-working" /> |
| `blocked` | `state-blocked` | Small image · `small_text` `blocked` | <img src="assets/state-blocked.png" width="48" alt="Asset key state-blocked" /> |
| `waiting` | `state-waiting` | Small image · `small_text` `waiting for input` | <img src="assets/state-waiting.png" width="48" alt="Asset key state-waiting" /> |
| `done` or unrecognized | `state-idle` | Small image · `small_text` `idle` (unknown states never leak) | <img src="assets/state-idle.png" width="48" alt="Asset key state-idle" /> |

Files: [`assets/orca.png`](assets/orca.png) · [`assets/state-working.png`](assets/state-working.png) · [`assets/state-blocked.png`](assets/state-blocked.png) · [`assets/state-waiting.png`](assets/state-waiting.png) · [`assets/state-idle.png`](assets/state-idle.png). The small image still follows agent status when `showAgentState` is off; that toggle only hides the text label.

---

## How it works

- **Snapshot, not focus.** Presence is workspace + agent status, not “the tab you are looking at.” Inputs are `agent.status.changed`, `workspace.readContext`, worktree created/removed, and a 90 s heartbeat. Focused-window detection is tracked in [#7](https://github.com/jondmarien/orca-discord-presence/issues/7) and needs host APIs we do not invent.
- **Privacy boundary.** [`src/presence/activity.ts`](src/presence/activity.ts) is the only module that chooses identifying strings. Discord, the HTTP bridge, and the companion transmit that result (or clear). Full gate table: [docs/privacy.md](docs/privacy.md).
- **Local IPC first.** The worker handshakes Discord desktop on the Orca **host/runtime** (Unix sockets or Windows pipes, including Vesktop Flatpak nests). Handshake retries 3 times with 3 s → 15 s backoff; a missing socket fails immediately so the companion can take over. Wire format and debounce: [docs/architecture.md](docs/architecture.md).
- **Opt-in companion.** If local IPC is down **and** you enable the bridge, the same privacy-gated activity is `POST`ed to a small HTTP → IPC process on any OS where Discord actually runs ([#6](https://github.com/jondmarien/orca-discord-presence/pull/6)). No dual-publish.
- **Stay alive.** Writes are debounced to Discord’s `SET_ACTIVITY` limit (at most one per 15 s). The heartbeat and **Show Status** re-send even when unchanged. **Reload RPC** closes, reconnects, and publishes again. Stop / deactivate send `SET_ACTIVITY` null first (no ghost “Playing Orca”).
- **Host gaps.** Palette toggles exist because panels cannot call `settings.set` today. Native dual-host / richer host APIs are fork-first Orca work — [#10](https://github.com/jondmarien/orca-discord-presence/issues/10) (replaces closed [#3](https://github.com/jondmarien/orca-discord-presence/issues/3)).

If **Show Status** reports `enabled=true connected=true detail=generic`, local IPC on the host is working. You do not need the companion unless Discord lives on a **different** machine.

---

## Features

### Core

- Privacy-first default (`detailLevel: generic`) — no workspace, branch, or machine name.
- Agent state + elapsed timer on; branch, terminals, and machine off until you opt in.
- Shipped Discord Application ID and Rich Presence assets — no developer account for end users.
- Local Discord / Vesktop / Vencord IPC on Linux, macOS, and Windows.
- Command-palette master switch, detail ladder, and per-field toggles.

### Advanced

- OS-agnostic companion bridge for dual-host setups ([#6](https://github.com/jondmarien/orca-discord-presence/pull/6)) — Tailscale, LAN, or SSH tunnel; token required off-loopback.
- Vesktop Flatpak + arRPC socket discovery (`$XDG_RUNTIME_DIR/.flatpak/dev.vencord.Vesktop/xdg-run/…`); reconstructs `/run/user/<uid>/` when the worker env drops `XDG_RUNTIME_DIR`.
- Handshake retry / backoff, fail-fast Application ID check, clear-before-close.
- 90 s `workspace.readContext` heartbeat (idle-reap is 5 minutes; branch switches emit no event).

### UX

- **Show Status** — force refresh + re-`SET_ACTIVITY`; toast includes `transmitting=…` (truncated last activity). Never prints the bridge token.
- **Reload RPC** — close IPC, reconnect, publish again (slow READY, competing RPC client, Discord restart).
- **Cycle Detail Level** — `off` → `generic` → `workspace` → `full`.
- Structured `orca.log` plus a capped on-disk log under XDG state / `%LOCALAPPDATA%`.
- v0.3 has no settings panel. A diagnostics sidebar is in progress in [PR #11](https://github.com/jondmarien/orca-discord-presence/pull/11) — not on this `main` yet.

---

## Installation

1. **Enable plugins** in Orca (`pluginSystemEnabled: true`).
2. **Load the plugin**
   - **Dev:** add this repo (the directory that contains `orca-plugin.json`) to Orca’s `devPluginPaths`.
   - **Marketplace:** install the listing whose qualified id is **`chron0.discord-presence`**.
3. **Approve consent** — `workspace:read`, `events:subscribe`, `storage`, `settings:own`, `notifications:show`. No `secrets`. No terminal write.
4. **Confirm** — keep Discord **desktop** signed in. Run **Discord Presence: Show Status**. Presence starts on the first agent/worktree event, command, or 90 s heartbeat — not necessarily at bare app launch.

---

## Configuration

There is no settings panel in v0.3. Each toggle is a command. `bridgeUrl` / `bridgeToken` persist via `settings:own` or env overlays.

### Defaults

| Setting | Default | Notes |
|---|---|---|
| `enabled` | `true` | Presence on, but generic. |
| `detailLevel` | `generic` | No workspace, branch, or machine name. |
| `showBranch` / `showMachine` / `showTerminals` | `false` | Identifying (or weakly identifying). |
| `showAgentState` / `showElapsed` | `true` | Labels + Discord start timestamp only. |
| `applicationId` | `1545653843239374848` | Public; lives in [`src/presence/settings.ts`](src/presence/settings.ts) as `SHIPPED_APPLICATION_ID`. |
| `bridgeEnabled` | `false` | Companion HTTP is off until you opt in. |
| `debugLogging` | `true` | `info`/`debug` to `orca.log` + file. Connect failures always log. |

Workspace, branch, and machine names — **when you enable them** — go to Discord’s servers and appear on your profile. See [docs/privacy.md](docs/privacy.md).

### Commands

| Command | Effect |
|---|---|
| Discord Presence: Enable/Disable | Master switch (`enabled`) |
| Discord Presence: Show Status | Force refresh + re-`SET_ACTIVITY`; toast `enabled=… connected=… sink=… transmitting=…` |
| Discord Presence: Reload RPC | Close + reconnect Discord IPC, then re-`SET_ACTIVITY` |
| Discord Presence: Cycle Detail Level | `off` → `generic` → `workspace` → `full` → … |
| Discord Presence: Toggle Branch | `showBranch` (needs `full`) |
| Discord Presence: Toggle Agent State | `showAgentState` |
| Discord Presence: Toggle Terminal Count | `showTerminals` |
| Discord Presence: Toggle Machine Name | `showMachine` (never at `generic`) |
| Discord Presence: Toggle Elapsed Timer | `showElapsed` |
| Discord Presence: Toggle Bridge | `bridgeEnabled` (still needs URL / token) |
| Discord Presence: Toggle Debug Logging | `debugLogging` |

### What Discord receives

| Field | Example | Gate | Default |
|---|---|---|---|
| Game name | `Orca` | Discord application name (not a plugin setting) | — |
| Details | `Working in Orca` | `detailLevel: generic` | on |
| Workspace | `acme-payments` | `detailLevel` ≥ `workspace` | off |
| Branch | `feat/refund-flow` | `full` + `showBranch` | off |
| Agent state | `working` / `blocked` / `waiting for input` / `idle` | `showAgentState` | on |
| Terminals | `3 terminals` | `showTerminals` | off |
| Machine | `jon-desktop` | `showMachine` and detail ≠ `generic` | off |
| Elapsed | start timestamp | `showElapsed` | on |
| Assets | large `orca`, small `state-*` | any non-null activity | — |

| Level | Permits |
|---|---|
| `off` | Nothing — presence cleared |
| `generic` | Non-identifying “Working in Orca” + optional agent / terminals / elapsed |
| `workspace` | Workspace display name; still no branch |
| `full` | Workspace + optional branch, machine, etc. |

The Application ID is public data (it is in every presence payload). Changing it requires a rebuild of `dist/`. v0.3 has no user-facing override UI.

---

## Dual-host companion

Local Discord IPC cannot leave the machine. The **host** is wherever the Orca **runtime** runs. The **companion** is a small HTTP → Discord-IPC process you run wherever Discord / Vesktop / Vencord-with-RPC is — Linux, macOS, or Windows. Shipped in [#6](https://github.com/jondmarien/orca-discord-presence/pull/6). Short companion notes: [`companion/README.md`](companion/README.md).

**Publish policy:** prefer local IPC when the host accepts a handshake. If that fails **and** the bridge is on, POST the same privacy-gated activity. The plugin does **not** dual-publish. Switching back to local IPC clears the remote activity.

A native host-mediated remote-presence API is future work — [#10](https://github.com/jondmarien/orca-discord-presence/issues/10). Installing this plugin on two machines is not a bridge by itself.

### 1. Companion (machine with Discord)

```bash
# repository root, Bun 1.4+
bun install
bun run companion
```

Or from `companion/`: `bun run start`. Default bind: `127.0.0.1:3848` (loopback; token optional).

Off-loopback (Tailscale / LAN):

```bash
export ORCA_PRESENCE_BIND=0.0.0.0
export ORCA_PRESENCE_PORT=3848
export ORCA_PRESENCE_BRIDGE_TOKEN='<high-entropy secret>'   # openssl rand -hex 32
bun run companion
```

PowerShell: `$env:ORCA_PRESENCE_BIND = "0.0.0.0"` (same names). Optional binary: `bun run companion:compile`.

| Env | Default | Notes |
|---|---|---|
| `ORCA_PRESENCE_BIND` | `127.0.0.1` | `0.0.0.0` or the companion’s Tailscale IP for a remote host |
| `ORCA_PRESENCE_PORT` | `3848` | |
| `ORCA_PRESENCE_BRIDGE_TOKEN` | empty | **Required** when bind is not loopback |
| `ORCA_PRESENCE_CLIENT_ID` | shipped Application ID | Same public snowflake as the plugin |

The companion **refuses to start** on a non-loopback bind without a token. It reuses `src/discord/ipc.ts` / `src/discord/client.ts` (win32 pipes, POSIX sockets, Vesktop Flatpak).

### 2. Reachability

**Tailscale (recommended):** same tailnet on host and Discord machine; bind `0.0.0.0` (or the Tailscale IP) + token; allow TCP `3848` on that interface; set host `bridgeUrl` to `http://<companion-tailscale-ip>:3848`.

**SSH tunnel:** keep the companion on loopback and forward from the Orca host:

```bash
ssh -N -L 3848:127.0.0.1:3848 user@companion-host
```

Then `bridgeUrl=http://127.0.0.1:3848` (token optional because the URL is loopback).

### 3. Plugin (Orca host)

| Setting | Default | Meaning |
|---|---|---|
| `bridgeEnabled` | `false` | Palette: **Discord Presence: Toggle Bridge** |
| `bridgeUrl` | `""` | `http` / `https` only, e.g. `http://100.x.y.z:3848` |
| `bridgeToken` | `""` | Same value as `ORCA_PRESENCE_BRIDGE_TOKEN` |

Host env overlays: `ORCA_PRESENCE_BRIDGE_ENABLED`, `ORCA_PRESENCE_BRIDGE_URL`, `ORCA_PRESENCE_BRIDGE_TOKEN`.

The token is a shared secret between host and companion — **not** sent to Discord, **not** printed by Show Status or written to logs (`token=***`). Only `http:` / `https:` URLs; no credentials-in-URL. Turn the bridge off when unused.

| Method | Path | Effect |
|---|---|---|
| `POST` | `/activity` | `SET_ACTIVITY` on the companion’s Discord client |
| `DELETE` | `/activity` | Clear |
| `GET` | `/health` | `{ ok, discordConnected }` (unauthenticated; no token in the body) |

Authenticated requests send `Authorization: Bearer <token>`.

---

## Diagnostics

`orca.log` is easy to miss. The same structured lines go to a capped file.

| Level | When |
|---|---|
| `error` / `warn` | Always (connect, `SET_ACTIVITY`, bridge, reload) |
| `info` / `debug` | When `debugLogging` is on (default **on**) |

```
[chron0.discord-presence] info activate version=0.3.0 debug=true file=/home/you/.local/state/chron0-discord-presence/plugin.log
[chron0.discord-presence] error discord.connect_failed reason="no discord ipc socket accepted a connection"
[chron0.discord-presence] info discord.set_activity sink=local details="Working in Orca"
```

| OS | Default path |
|---|---|
| Linux / macOS | `$XDG_STATE_HOME/chron0-discord-presence/plugin.log` or `~/.local/state/chron0-discord-presence/plugin.log` |
| Windows | `%LOCALAPPDATA%\chron0-discord-presence\plugin.log` |

Override with `ORCA_PRESENCE_LOG_FILE`. Rotates to `plugin.log.1` at 256 KiB.

`connected=true` means **local** IPC on the Orca host succeeded. `sink=bridge` means the companion published instead.

---

## Building

Bun is the package manager, test runner, and build tool. **Do not** call `Bun.file` or other Bun-only APIs on the Discord IPC path — Orca loads `dist/main.js`.

```bash
bun install
bun test
bun run typecheck
bun run build
```

| Script | What it does |
|---|---|
| `bun install` | Exact lockfile versions (`bunfig.toml` `exact = true`) |
| `bun test` | `test/*.ts` (fake IPC / fake clock; no live Discord) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build` | `src/main.ts` → `dist/main.js` (`--target node --format esm`) |
| `bun run companion` | Companion on this OS |
| `bun run companion:compile` | Optional standalone binary |

Commit `dist/main.js` when TypeScript sources change so `devPluginPaths` and marketplace installs work without a local build. Zero production dependencies. File-level JSDoc only (`@module`, `@author Jonathan Marien`, `@date`).

Module map, opcodes, and debounce: [docs/architecture.md](docs/architecture.md).

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| No presence at all | Discord **browser** only | Open the Discord **desktop** app and stay signed in |
| Desktop running, still nothing | **Activity Privacy** off | Discord / Vesktop → **Settings → Activity Privacy** → **Display current activity as a status message** |
| `connected=false` | Client not ready, or IPC socket missing | Start desktop; wait ≤90 s. **Reload RPC** retries handshake (3 tries, 3 s → 15 s) |
| Handshake fails then recovers | Pipe accepted before `READY` (`data` null) | Retryable. Watch `discord.client` `connect attempt … retrying` in the log |
| Invalid Application ID toast | Persisted id is not a 17–20 digit snowflake | Falls back to the shipped id; `discord.app_id_invalid` |
| Status flickers / another game wins | Competing RPC client | **Reload RPC**, or wait for the 90 s `forceTransmit`. Discord shows one activity per application |
| “Playing Orca” after quit | Ghost activity | Stop now sends `SET_ACTIVITY` null first. **Reload RPC** or toggle Enable/Disable once |
| Presence gone after ~5 min idle | Worker idle-reap | Heartbeat should prevent this; confirm the plugin is still enabled |
| Stale branch | Branch switches emit no host event | Wait ≤90 s, or **Show Status** / **Reload RPC** |
| Lags during agent tool-use | Discord rate limit | Expected: at most one `SET_ACTIVITY` per 15 s |
| Linux cannot find the socket | `XDG_RUNTIME_DIR` stripped | Plugin reconstructs `/run/user/<uid>/` and Flatpak/Snap nests |
| Vesktop Flatpak + arRPC, no presence | Socket inside the sandbox | Enable **Rich Presence via arRPC**. Plugin also probes `.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-*` |
| Agents on host, Discord on another OS | Local IPC cannot cross machines | [Dual-host companion](#dual-host-companion) |
| Cannot find logs | `orca.log` is easy to miss | **Show Status**; then `~/.local/state/chron0-discord-presence/plugin.log` or `%LOCALAPPDATA%\…` |
| Wrong / missing art | Assets not propagated, or wrong Application ID | Confirm keys `orca`, `state-working`, `state-blocked`, `state-waiting`, `state-idle` |
| `activate` killed at startup | Handshake blocked the ready timeout | First refresh is fire-and-forget |

**Show Status** never prints the bridge token. **Reload RPC** is the “Discord restarted / Vesktop was slow / another client stole the activity” command.

### Known limits

- No file-level presence (host API exposes none).
- No focused-window / active-tab detection ([#7](https://github.com/jondmarien/orca-discord-presence/issues/7)).
- Machine name is `os.hostname()` in the plugin worker (Orca **client**), not an SSH remote host.
- Companion is the supported dual-host path ([#6](https://github.com/jondmarien/orca-discord-presence/pull/6)); native host mediation is [#10](https://github.com/jondmarien/orca-discord-presence/issues/10).
- Presence starts on the first event, command, or heartbeat — not at bare launch.
- Activity expiry helpers in [`src/presence/expiry.ts`](src/presence/expiry.ts) are for future focus/tool providers — not applied to today’s snapshot.

---

## Docs

| Doc | What |
|---|---|
| [What is this?](#what-is-this) | Identity, default Discord copy, inputs |
| [Presence look](#presence-look) | Activity states + in-repo `assets/` previews |
| [How it works](#how-it-works) | IPC, privacy, heartbeat |
| [Features](#features) | Core / advanced / UX |
| [Installation](#installation) | Enable, load, consent, Show Status |
| [Configuration](#configuration) | Defaults, commands, disclosure |
| [Dual-host companion](#dual-host-companion) | Bridge, Tailscale, SSH |
| [Diagnostics](#diagnostics) | `orca.log` + file path |
| [Building](#building) | Bun scripts |
| [Troubleshooting](#troubleshooting) | Desktop, Vesktop, dual-host |
| [docs/architecture.md](docs/architecture.md) | Process model, IPC opcodes, debounce, Reload RPC |
| [docs/privacy.md](docs/privacy.md) | Gate table and never-transmitted list |
| [companion/README.md](companion/README.md) | Companion start / HTTP surface |
| [ROADMAP.md](ROADMAP.md) | Limits and follow-up work |
| [#6](https://github.com/jondmarien/orca-discord-presence/pull/6) | Companion MVP (merged) |
| [#7](https://github.com/jondmarien/orca-discord-presence/issues/7) | Focused window / tab (blocked on host APIs) |
| [#10](https://github.com/jondmarien/orca-discord-presence/issues/10) | Host capabilities; fork-first Orca PRs |
| [PR #11](https://github.com/jondmarien/orca-discord-presence/pull/11) | Diagnostics panel (in progress; not on `main`) |
| [Issues](https://github.com/jondmarien/orca-discord-presence/issues) | Tracker |

---

## License

MIT

---

<div align="center">

`chron0.discord-presence` · Jonathan Marien · [Architecture](docs/architecture.md) · [Privacy](docs/privacy.md) · [Roadmap](ROADMAP.md) · [Issues](https://github.com/jondmarien/orca-discord-presence/issues)

</div>
