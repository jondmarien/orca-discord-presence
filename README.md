# Discord Rich Presence for Orca

Shows your current Orca workspace, branch, and agent state as Discord Rich Presence.

Every identifying field is **opt-in**. The default detail level (`generic`) never transmits a repo, branch, or machine name — only non-identifying copy such as `Working in Orca`, plus optional agent state and an elapsed timer.

**Plugin id:** `chron0.discord-presence`  
**Publisher / id:** `chron0` / `discord-presence` (do not rename)  
**Requires:** Orca `>=1.4.0`, Discord **desktop** client (on the Orca host **or** a companion on any OS where Discord/Vesktop/Vencord runs)  
**Author:** Jonathan Marien  
**Version:** 0.4.0

Browser Discord has **no** IPC socket. Presence will never appear if only the web client is open.

Deeper notes: [Architecture](docs/architecture.md) · [Privacy](docs/privacy.md) · [Roadmap](ROADMAP.md)

---

## What it does

The plugin is a trusted Orca worker (`dist/main.js`) that:

1. Reads workspace context (`displayName`, `branch`, terminal count) and agent status events (`agent.status.changed`).
2. Applies privacy gates (detail level + per-field toggles).
3. Writes a Discord Rich Presence activity to the **local** Discord desktop IPC socket when one is available on the Orca **host/runtime**.
4. If local IPC is down and the opt-in **companion bridge** is enabled, POSTs the same privacy-gated activity to a companion on **any OS** (Linux, macOS, or Windows) that has Discord / Vesktop / Vencord, which calls `SET_ACTIVITY` there.
5. Debounces writes to Discord’s `SET_ACTIVITY` rate limit (at most one update per 15 seconds).
6. Heartbeats every 90 seconds so the worker is not idle-reaped, branch switches are picked up, and `SET_ACTIVITY` is **re-sent** even if the payload is unchanged (Discord or another IPC client can overwrite us).

No Discord developer account is required for end users. The plugin ships its own Discord Application ID. There is **no bot token and no client secret**.

Orca loads `dist/main.js` (see `orca-plugin.json` `main`). That file is Node/Electron-compatible ESM — you do **not** need Bun installed to *run* the plugin.

### What we do not detect

The plugin does **not** know which Orca UI window or tab is focused (terminal vs Cursor agent window, or which remote UI). Presence is driven only by:

- `agent.status.changed` (agent `working` / `blocked` / `waiting` / `done`)
- `workspace.readContext` (display name, branch, terminal **count**)
- worktree created/removed events and the 90 s heartbeat

If Orca later exposes active-tab or focus events, we can subscribe. We will not invent that signal.

If **Show Status** reports `enabled=true connected=true detail=generic`, **local IPC on the Orca host is working**. The companion is only for the case where Discord lives on a **different** machine than the host.

---

## Privacy defaults

| Setting | Default | Why |
|---|---|---|
| `enabled` | `true` | Presence is on, but generic. |
| `detailLevel` | `generic` | No workspace, branch, or machine name. |
| `showBranch` | `false` | Branch is identifying. |
| `showMachine` | `false` | Hostname is identifying. |
| `showTerminals` | `false` | Count is weakly identifying. |
| `showAgentState` | `true` | `working` / `blocked` / `waiting for input` / `idle` only. |
| `showElapsed` | `true` | Discord start timestamp; no names. |
| `applicationId` | `1545653843239374848` | Public snowflake (not a secret). |
| `machineLabel` | `null` | Optional override if you enable machine later. |
| `bridgeEnabled` | `false` | HTTP companion is **off** until you opt in. |
| `bridgeUrl` | `""` | Companion base URL (`http` / `https` only). |
| `bridgeToken` | `""` | Shared bearer token; required when the URL is not loopback. |
| `debugLogging` | `true` | Structured `orca.log` + on-disk plugin log (connect failures always logged). |

Workspace names, branch names, and machine names — **when you enable them** — are sent to Discord’s servers and rendered publicly on your profile. Client repository names can identify clients.

See [docs/privacy.md](docs/privacy.md) for the full gate table and what is never transmitted.

---

## Discord Application ID and Rich Presence assets

The plugin ships Application ID **`1545653843239374848`**. The Discord Developer Portal already has this application and the five Rich Presence art assets uploaded:

| Asset key | Role | Source PNG |
|---|---|---|
| `orca` | Large image | [`assets/orca.png`](assets/orca.png) |
| `state-working` | Small image | [`assets/state-working.png`](assets/state-working.png) |
| `state-blocked` | Small image | [`assets/state-blocked.png`](assets/state-blocked.png) |
| `state-waiting` | Small image | [`assets/state-waiting.png`](assets/state-waiting.png) |
| `state-idle` | Small image | [`assets/state-idle.png`](assets/state-idle.png) |

Changing the Application ID requires a plugin release. v0.4 has a diagnostics panel but **no** Application ID override UI (v1.0 may add one after host B4). The id lives in [`src/presence/settings.ts`](src/presence/settings.ts) as `SHIPPED_APPLICATION_ID`. Rebuild `dist/` after changing it. The panel never displays the Application ID.

There is **no Discord bot token or client secret** in this plugin. The Application ID is public data (it appears in every presence payload).

---

## Install

### 1. Enable plugins in Orca

Set `pluginSystemEnabled: true` in Orca’s settings.

### 2. Load the plugin

**Dev (local checkout)** — add this repo to Orca’s `devPluginPaths` (absolute path to the repository root that contains `orca-plugin.json`).

**Marketplace** — install the listing whose qualified id is **`chron0.discord-presence`**.

### 3. Approve consent

The manifest requests only:

| Capability | Used for |
|---|---|
| `workspace:read` | `workspace.readContext` (name, branch, terminals) |
| `events:subscribe` | `agent.status.changed`, `worktree.created`, `worktree.removed` |
| `storage` | Host storage (declared; settings use `settings:own`) |
| `settings:own` | Persist toggles via `settings.get` / `settings.set` |
| `notifications:show` | **Show Status** toast (command palette and the sidebar panel) |

No `secrets` capability. No terminal write.

### 4. Confirm it is alive

Run **Discord Presence: Show Status** from the command palette. Presence starts on the first agent event, worktree event, command, or 90 s heartbeat — not necessarily at bare app launch.

Keep the Discord **desktop** client signed in and running.

Open the **Discord Presence** tab in the right sidebar (`plugin:chron0.discord-presence/presence`) for live workspace context and a read-only snapshot. See [Diagnostics panel](#diagnostics-panel-orca-right-sidebar).

---

## Commands

Panels cannot call `settings.set` in Orca’s current host API, so each toggle is a command:

| Command | Effect |
|---|---|
| Discord Presence: Enable/Disable | Master switch (`enabled`) |
| Discord Presence: Show Status | Force refresh + re-`SET_ACTIVITY`; toast includes `transmitting=…` (truncated last activity) |
| Discord Presence: Reload RPC | Close + reconnect Discord IPC, then re-`SET_ACTIVITY` |
| Discord Presence: Cycle Detail Level | `off` → `generic` → `workspace` → `full` → … |
| Discord Presence: Toggle Branch | `showBranch` |
| Discord Presence: Toggle Agent State | `showAgentState` |
| Discord Presence: Toggle Terminal Count | `showTerminals` |
| Discord Presence: Toggle Machine Name | `showMachine` |
| Discord Presence: Toggle Elapsed Timer | `showElapsed` |
| Discord Presence: Toggle Bridge | `bridgeEnabled` (still needs `bridgeUrl` / token) |
| Discord Presence: Toggle Debug Logging | `debugLogging` |

---

## Diagnostics panel (Orca right sidebar)

v0.4 ships one experimental panel:

| Manifest | Value |
|---|---|
| `id` | `presence` |
| Title | Discord Presence |
| Icon | Lucide `radio` |
| Entry | `panel/index.html` |
| Sidebar tab | `plugin:chron0.discord-presence/presence` |

**Open it:** enable the plugin, then open Orca’s **right sidebar** and click the Discord Presence (radio) activity-bar icon.

The iframe is sandboxed. Host CSP is `default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:` (plus host extras). The panel **cannot** `fetch`, read files, or call `settings.*` / `storage.*` / `secrets.*` / `events.subscribe` / command invoke.

### What works today

| Surface | How |
|---|---|
| Live workspace | `workspace.readContext` via `postMessage` `{ type: 'orca-panel-action' }` — display name, branch, terminal count |
| Show Status toast | `notifications.show` with compact `enabled` / `connected` / `sink` / `detail` from the embedded snapshot |
| Refresh | Re-reads workspace context and re-renders `window.__PRESENCE_PANEL__` if the worker embedded a snapshot |
| Read-only toggles | Checkboxes reflect the last snapshot (not live settings). They do **not** persist — that still needs host B4 |
| Collapsible logs | Ring-buffer lines the worker embeds when it can rewrite `panel/index.html` |
| Reload RPC / Cycle Detail / Enable | Command palette only. The panel button labeled **Reload RPC (palette)** is a reminder toast, not a reconnect |

### Snapshot + static shell

1. `panel/index.html` is a **static shell**. Marketplace / immutable installs still show live workspace + empty logs + the conventional log path and “run Show Status” copy.
2. On a **writable** install (`devPluginPaths`), the worker keeps an in-memory log ring and, on activate / Show Status / Reload RPC / heartbeat (debounced), rewrites a `#presence-snapshot` JSON blob (`window.__PRESENCE_PANEL__`). Reopen the tab to load a newer rewrite.
3. Override path: `ORCA_PRESENCE_PANEL_HTML`. Skip writes: `ORCA_PRESENCE_SKIP_PANEL_WRITE=1`.
4. The Discord Application ID and bridge token are **never** written into the panel. Log lines are redacted (`token=***`).

A real settings + live log panel still needs host work tracked on [issue #3](https://github.com/jondmarien/orca-discord-presence/issues/3) (PLAN.md Task B4: panel-callable `settings.*` / `storage.*` or `commands.invoke` / log tail). Do not wait on that for this MVP.

---

## What is transmitted

| Field | Example | Setting / gate | Default |
|---|---|---|---|
| Game name | `Orca` | Discord application name (not a plugin setting) | — |
| Details (generic) | `Working in Orca` | `detailLevel: generic` | on |
| Workspace name | `acme-payments` | `detailLevel` ≥ `workspace` | off |
| Branch | `feat/refund-flow` | `detailLevel: full` + `showBranch` | off |
| Agent state | `working` / `blocked` / `waiting for input` / `idle` | `showAgentState` | on |
| Terminal count | `3 terminals` | `showTerminals` | off |
| Machine name | `jon-desktop` | `showMachine` (never at `generic`) | off |
| Elapsed timer | Discord start timestamp | `showElapsed` | on |
| Assets | large `orca`, small `state-*` | always when presence is active | — |

Detail-level ladder (cycle with **Discord Presence: Cycle Detail Level**):

| Level | Permits |
|---|---|
| `off` | Nothing — presence cleared |
| `generic` | Non-identifying “Working in Orca” + optional agent state / terminals / elapsed |
| `workspace` | Workspace display name; still no branch |
| `full` | Workspace + optional branch, machine, etc. |

Unrecognized agent states are **not** forwarded. They render as `idle` / `state-idle`.

---

## Architecture

```
src/main.ts                 activate / deactivate + command / event / heartbeat wiring
src/discord/ipc.ts          socket path candidates + 8-byte frame codec
src/discord/client.ts       handshake, retry/backoff, SET_ACTIVITY, ping/pong, teardown
src/discord/retry.ts        capped exponential backoff + handshake-not-ready
src/discord/app-id.ts       fail-fast Application ID (snowflake) validation
src/presence/settings.ts    defaults, normalize, detail-level cycle, field toggles
src/presence/activity.ts    privacy-gated activity builder (the disclosure boundary)
src/presence/controller.ts  snapshot cache, 15 s debounce, local-then-bridge publish
src/presence/expiry.ts      activity-window helper for future focus/tool providers (#7)
src/presence/bridge.ts      companion URL/token hygiene + HTTP client
src/presence/log.ts         structured orca.log + capped file log
src/presence/log-ring.ts    in-memory recent lines for the panel snapshot
src/presence/panel-snapshot.ts  redacted status / toggles / logs (no token, no App ID)
src/presence/panel-html.ts  embed snapshot into panel/index.html when writable
src/version.ts              semver shared by manifest, worker, and panel
panel/index.html            sandboxed right-sidebar diagnostics panel
companion/                  OS-agnostic HTTP → local Discord IPC (Linux/macOS/Windows)
dist/main.js                Orca entry (bundled Node ESM)
```

| Concern | Module |
|---|---|
| Host lifecycle | `src/main.ts` — `export default activate`, `export function deactivate` |
| IPC paths + framing | `src/discord/ipc.ts` |
| RPC session | `src/discord/client.ts` (3× handshake retry, 3s→15s cap; clear-before-close) |
| Settings shape | `src/presence/settings.ts` |
| What Discord sees | `src/presence/activity.ts` |
| When Discord is written | `src/presence/controller.ts` (prefer local IPC, else opt-in bridge) |
| Companion HTTP client | `src/presence/bridge.ts` |
| Diagnostics | `src/presence/log.ts` + log ring + panel snapshot |
| Sidebar panel | `panel/index.html` — `workspace.readContext` + `notifications.show` only |
| Companion server (any OS) | `companion/main.ts` |

Orca’s plugin worker is **Electron/Node**, not Bun. Shipped code uses only `node:*` APIs (`net`, `os`, `crypto`, timers). See [docs/architecture.md](docs/architecture.md) for IPC opcodes, debounce, and idle-reap details.

---

## Development (Bun)

Bun is the package manager, test runner, and (optional) build tool. **Do not** call `Bun.file` or other Bun-only APIs on the Discord IPC path — Orca loads Node-compatible ESM from `dist/main.js`.

```bash
bun install
bun test
bun run typecheck
bun run build
```

| Script | What it does |
|---|---|
| `bun install` | Installs exact lockfile versions (`bunfig.toml` `exact = true`) |
| `bun test` | Runs `test/*.ts` (fake IPC / fake clock; no live Discord required) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build` | Bundles `src/main.ts` → `dist/main.js` (`--target node --format esm`) |
| `bun run companion` | Starts the Discord-IPC companion (`companion/main.ts`) on this OS |
| `bun run companion:compile` | Optional standalone binary (`companion/orca-presence-companion`) |

`bun run build` emits Node-compatible ESM at `dist/main.js`. Commit that file when the TypeScript sources change so `devPluginPaths` and marketplace installs work without a local build.

Zero production dependencies. Hand-rolled Discord IPC over `node:net`. Dev-only deps are TypeScript and `@types/bun`.

TypeScript sources carry JSDoc (`@module`, `@author Jonathan Marien`, `@date`) on the file-level module header only.

---

## Diagnostics (orca.log + file)

`orca.log` exists but is easy to miss in the Orca UI. The plugin also writes the same structured lines to a capped file.

| Level | When it is written |
|---|---|
| `error` / `warn` | **Always** (connect failures, SET_ACTIVITY / bridge failures) — even if `debugLogging` is off |
| `info` / `debug` | When `debugLogging` is on (default **on** for this release) |

Lines look like:

```
[chron0.discord-presence] info activate version=0.4.0 debug=true file=/home/you/.local/state/chron0-discord-presence/plugin.log
[chron0.discord-presence] error discord.connect_failed reason="no discord ipc socket accepted a connection"
[chron0.discord-presence] warn discord.client reason="connect attempt 1/3 failed: …; retrying in 3000ms"
[chron0.discord-presence] error discord.app_id_invalid reason="…" rejected=not-a-snowflake fallback=1545653843239374848
[chron0.discord-presence] info discord.reload_command
[chron0.discord-presence] info discord.set_activity sink=local details="Working in Orca"
[chron0.discord-presence] info bridge.publish url=http://100.x.y.z:3848
```

The bearer token is never logged (`token=***` if a caller slips).

### Where the file lives

| OS | Default path |
|---|---|
| Linux / most POSIX | `$XDG_STATE_HOME/chron0-discord-presence/plugin.log` or `~/.local/state/chron0-discord-presence/plugin.log` |
| macOS | same XDG / `~/.local/state/…` path |
| Windows | `%LOCALAPPDATA%\chron0-discord-presence\plugin.log` |

Override with `ORCA_PRESENCE_LOG_FILE`. The active file rotates to `plugin.log.1` at 256 KiB.

### How to read status

1. Command palette → **Discord Presence: Show Status**, or the sidebar panel’s **Show Status** button (toast from the embedded snapshot).
2. The palette toast repeats `enabled=… connected=… sink=…` plus **`transmitting=…`** (the last activity JSON, truncated). This command also forces a re-`SET_ACTIVITY`.
3. The full line (plus file path) is written to `orca.log` and the file. The panel log view shows the same ring when the worker could rewrite `panel/index.html`.

`connected=true` means **local** Discord IPC on the Orca host succeeded (your Omarchy smoke: `enabled=true connected=true detail=generic`). `sink=bridge` means the companion published instead.

Toggle verbosity with **Discord Presence: Toggle Debug Logging** (`debugLogging`). Connect failures stay on either way.

---

## Cross-machine companion (Linux ↔ macOS ↔ Windows)

Local Discord IPC cannot leave the machine. The **host** is wherever the Orca **runtime** runs (Linux, macOS, or Windows). The **companion** is a small HTTP → Discord-IPC process you run wherever Discord / Vesktop / Vencord-with-RPC actually is — any of those three OSes.

One common setup is Omarchy (Arch) host + Windows Discord. The same path works Linux↔macOS, two Linux boxes, etc.

**Publish policy:** prefer **local Discord IPC** when a desktop client on the Orca host accepts the handshake. If that fails **and** the bridge is enabled, POST the same privacy-gated activity to the companion. The plugin does **not** dual-publish. Switching from bridge back to local IPC clears the remote activity.

If Show Status already says `connected=true`, you do **not** need the companion unless you want Discord on a different machine to be the IPC publisher.

This is the [#3](https://github.com/jondmarien/orca-discord-presence/issues/3) **plugin MVP**. It does not change Orca core. A native Orca remote-presence / host-mediated API is still future work — [ROADMAP.md](ROADMAP.md).

### 1. Companion (the machine with Discord)

On Linux, macOS, or Windows (Discord, Vesktop + arRPC, or Vencord-with-RPC signed in):

```bash
# repository root, Bun 1.4+
bun install
bun run companion
```

Or from `companion/`: `bun run start`.

Defaults: bind `127.0.0.1:3848` (loopback only; token optional).

To accept traffic from another machine over Tailscale or LAN:

```bash
export ORCA_PRESENCE_BIND=0.0.0.0
export ORCA_PRESENCE_PORT=3848
export ORCA_PRESENCE_BRIDGE_TOKEN='<high-entropy secret>'
bun run companion
```

PowerShell: `$env:ORCA_PRESENCE_BIND = "0.0.0.0"` (same names).

Optional standalone binary:

```bash
bun build companion/main.ts --compile --outfile companion/orca-presence-companion
```

| Env | Default | Notes |
|---|---|---|
| `ORCA_PRESENCE_BIND` | `127.0.0.1` | Use `0.0.0.0` or the companion’s Tailscale IP for a remote host |
| `ORCA_PRESENCE_PORT` | `3848` | |
| `ORCA_PRESENCE_BRIDGE_TOKEN` | empty | **Required** when bind is not loopback |
| `ORCA_PRESENCE_CLIENT_ID` | shipped Application ID | Same public snowflake as the plugin |

The companion **refuses to start** on a non-loopback bind without a token. It reuses `src/discord/ipc.ts` / `src/discord/client.ts` on every OS (win32 pipes, POSIX sockets, Vesktop Flatpak nests).

### 2. Tailscale (recommended)

1. Install Tailscale on the Orca host and the Discord machine; same tailnet.
2. Bind the companion to `0.0.0.0` or that machine’s Tailscale IP, with a token.
3. Allow inbound TCP `3848` from the Tailscale interface (firewall on that OS).
4. On the Orca host, set `bridgeUrl` to `http://<companion-tailscale-ip>:3848`.

Prefer Tailscale (or another overlay) over opening the port on a public LAN.

### 3. SSH tunnel (alternative)

If you would rather not bind off-loopback:

```bash
# on the Orca host — forwards local 3848 to the companion’s loopback
ssh -N -L 3848:127.0.0.1:3848 user@companion-host
```

Keep the companion on `127.0.0.1:3848`. On the host, `bridgeUrl=http://127.0.0.1:3848` (token optional because the URL is loopback).

### 4. Plugin settings (Orca host, any OS)

The bridge is **off** by default. Enable it only when you intend to send activity to another machine.

| Setting | Default | Meaning |
|---|---|---|
| `bridgeEnabled` | `false` | Master switch. Palette: **Discord Presence: Toggle Bridge** |
| `bridgeUrl` | `""` | Companion base URL, e.g. `http://100.x.y.z:3848` |
| `bridgeToken` | `""` | Same value as `ORCA_PRESENCE_BRIDGE_TOKEN`. Required when the URL host is not loopback |

v0.4’s sidebar panel is **diagnostics only** — it cannot persist `bridgeUrl` / `bridgeToken` (host B4). Use the plugin `settings:own` store, or overlay them at worker start:

| Env (Orca host) | Effect |
|---|---|
| `ORCA_PRESENCE_BRIDGE_ENABLED=true` | Sets `bridgeEnabled` (`0` / `false` forces off) |
| `ORCA_PRESENCE_BRIDGE_URL` | Sets `bridgeUrl` (`http` / `https` only) |
| `ORCA_PRESENCE_BRIDGE_TOKEN` | Sets `bridgeToken` |

The payload is the same privacy-gated activity the local IPC path would send. The token is a shared secret between host and companion — it is **not** sent to Discord. Disable/stop clears remote activity.

### Security

- Default bind is loopback. Non-loopback listen **requires** a bearer token (companion will not start otherwise).
- The plugin will not POST to a non-loopback URL without a token.
- Use a long random token (`openssl rand -hex 32`). Do not commit it. **Show Status** never prints the token.
- Treat `bridgeUrl` as a trusted sink you control. Only `http:` / `https:` are accepted (no credentials-in-URL).
- Turn the bridge off when you are not using it.

### HTTP protocol

| Method | Path | Body | Effect |
|---|---|---|---|
| `POST` | `/activity` | Discord activity JSON | `SET_ACTIVITY` on the companion’s Discord client |
| `DELETE` | `/activity` | — | Clear activity |
| `GET` | `/health` | — | `{ ok, discordConnected }` (no token in the response) |

Authenticated requests send `Authorization: Bearer <token>`. `GET /health` is unauthenticated so you can smoke-test reachability without printing secrets.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| No presence at all | Discord **browser** only | Open the Discord **desktop** app and stay signed in |
| No presence; desktop is running | **Activity Privacy** is off | Discord / Vesktop → **Settings → Activity Privacy** → enable **Display current activity as a status message** (and allow the game activity). This plugin cannot override that user setting. |
| Status says `connected=false` | Desktop client not running, or IPC socket not found | Start Discord desktop; wait ≤90 s for the heartbeat retry. If Vesktop was still starting, **Reload RPC** retries the handshake (3 tries, 3s→15s backoff). |
| Handshake fails then recovers | Discord/Vesktop accepted the pipe before READY (`data` null) | Treated as retryable. Watch `orca.log` / the plugin file for `discord.client` `connect attempt … retrying`. |
| Invalid Application ID toast | Persisted id is not a 17–20 digit snowflake | Plugin falls back to the shipped id and logs `discord.app_id_invalid`. The shipped snowflake is always accepted. |
| Status flickers / another game wins | **Competing RPC clients** (another IDE, game overlay, or second presence plugin) | Discord shows one activity per application. Run **Reload RPC** (close + reconnect + re-`SET_ACTIVITY`) or wait for the 90 s heartbeat `forceTransmit`. Disable the other client if it keeps overwriting Orca. |
| “Playing Orca” stays after quit | Ghost activity (older builds left the last `SET_ACTIVITY` on Discord) | Deactivate/stop now sends `SET_ACTIVITY` **null** before closing the socket. If you still see a ghost from a previous session, **Reload RPC** or toggle Enable/Disable once. |
| Presence vanished after ~5 minutes idle | Worker idle-reap (no host calls) | Heartbeat should prevent this; confirm the plugin is still enabled |
| Stale branch on the profile | Branch switches emit no host event | Wait for the 90 s heartbeat, or run **Show Status** / **Reload RPC** / any toggle |
| Presence lags during agent tool-use | Discord rate limit | Expected: at most one `SET_ACTIVITY` per 15 s; newest state wins |
| Manual smoke activity shows, live plugin does not stick | Another IPC client or Discord restart replaced our payload; we used to skip identical JSON | Fixed: heartbeat and **Show Status** force a re-`SET_ACTIVITY`. **Reload RPC** also reconnects the pipe. |
| Linux worker cannot find the socket | `XDG_RUNTIME_DIR` stripped from the worker env | Plugin reconstructs `/run/user/<uid>/` and Flatpak/Snap nests |
| Vesktop Flatpak + arRPC, no presence | Socket is inside the Vesktop sandbox, not at `$XDG_RUNTIME_DIR/discord-ipc-0` | Enable **Rich Presence via arRPC** in Vesktop. The plugin also probes `$XDG_RUNTIME_DIR/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-*` (and `/run/user/<uid>/…` when XDG is missing). Keep the desktop client running. |
| Host has agents, Discord is on another OS, no presence | Local IPC cannot cross machines; bridge off by default | Run the companion on the Discord machine and enable the bridge — [Cross-machine companion](#cross-machine-companion-linux--macos--windows) |
| Cannot find plugin logs in the UI | `orca.log` is easy to miss | Open the **Discord Presence** sidebar panel (collapsible Extension Logs) or run **Show Status** / **Reload RPC**; read `~/.local/state/chron0-discord-presence/plugin.log` (or `%LOCALAPPDATA%\…`). Marketplace installs may show an empty log view until the worker can rewrite the panel HTML. Token is never logged. See [Diagnostics](#diagnostics-orcalog--file) |
| Panel toggles do nothing | `settings.set` is not panel-callable | Expected. Use the command palette. Host gap: [#3](https://github.com/jondmarien/orca-discord-presence/issues/3) / PLAN.md B4 |
| Wrong / missing art | Assets not yet propagated, or wrong Application ID | Confirm keys `orca`, `state-working`, `state-blocked`, `state-waiting`, `state-idle` |
| `activate` killed at startup | Handshake blocked the ready timeout | First refresh is fire-and-forget; if you changed that, restore it |

**Show Status** forces a refresh and re-publish, then toasts `enabled=… connected=… sink=… transmitting=…`. That JSON is what was last sent (or `null`). **Reload RPC** closes the IPC socket (after `SET_ACTIVITY` null), reconnects, and publishes again — use it when Vesktop was slow to READY or another RPC client stole the activity. The token is never logged.

---

## Known limits

- No file-level presence (Orca host API v0 exposes none).
- **No focused-window / active-tab detection.** Presence is not “what UI you are looking at”; it is workspace + agent status. See [What we do not detect](#what-we-do-not-detect).
- Machine name is the **Orca client** hostname (`os.hostname()` in the plugin worker), not an SSH remote host.
- Local Discord IPC still cannot leave the host. The **opt-in companion** ([#3](https://github.com/jondmarien/orca-discord-presence/issues/3) plugin MVP) is the supported cross-machine path (any OS ↔ any OS); a native Orca remote-presence API is still future work — [ROADMAP.md](ROADMAP.md).
- Installing this plugin on two machines does not, by itself, bridge agent events. The Discord machine must run the companion (or be the Orca host with Discord).
- Presence starts on the first agent/worktree event, command, or 90 s heartbeat — not at bare app launch.
- Idle-reap survival depends on a 90 s `workspace.readContext` heartbeat (worker is reaped after 5 minutes of no host calls).
- **Diagnostics panel shipped (v0.4).** Live workspace + notifications work. Field toggles are read-only until host B4. Logs are a worker-embedded snapshot on writable installs; immutable marketplace copies show the conventional path and “run Show Status”. Tracked in [#3](https://github.com/jondmarien/orca-discord-presence/issues/3).
- A **settings** panel (writable toggles, Application ID override) is still blocked on panel-callable `settings.*` / `storage.*`. `bridgeUrl` / `bridgeToken` remain persisted settings or env overlays.
- Activity **expiry windows** (30s/60s sticky-state reap — same Discord IPC lesson as a prior Rich Presence integration) are documented in [`src/presence/expiry.ts`](src/presence/expiry.ts) for future focus/tool providers ([#7](https://github.com/jondmarien/orca-discord-presence/issues/7)). They are not applied to today’s agent/workspace snapshot.

---

## Verification matrix

| Check | Expected |
|---|---|
| Unit suite | `bun test` all pass (fake IPC for client tests) |
| Idle 7+ minutes with desktop client open | Presence still live (heartbeat) |
| Quit then restart desktop client | Silent degrade; returns within one heartbeat (≤90 s) |
| Agent tool-use burst | At most one `SET_ACTIVITY` per 15 s |
| Linux env-stripped worker | Socket via `/run/user/<uid>/` (official Discord Flatpak/Snap nests, plus Vesktop Flatpak arRPC) |
| SSH workspace | Presence reflects workspace; machine name if enabled is local |
| Dual-host: Orca host (no Discord) + companion on the Discord OS + bridge on | Presence via that machine’s `SET_ACTIVITY` ([#3](https://github.com/jondmarien/orca-discord-presence/issues/3) MVP) |
| Dual-host without companion / with `bridgeEnabled: false` | No presence (privacy default) unless the **host** also has Discord (`connected=true`) |
| Smoke: host + Vesktop signed in (arRPC) + plugin | `Show Status` → `connected=true`; presence on the Discord account from every client |

Manual install/consent/live-presence checks need the desktop client. The Application ID in `src/presence/settings.ts` is already the shipped snowflake.
