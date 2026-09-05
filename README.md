# Discord Rich Presence for Orca

Shows your current Orca workspace, branch, and agent state as Discord Rich Presence.

Every identifying field is **opt-in**. The default detail level (`generic`) never transmits a repo, branch, or machine name — only non-identifying copy such as `Working in Orca`, plus optional agent state and an elapsed timer.

**Plugin id:** `chron0.discord-presence`  
**Publisher / id:** `chron0` / `discord-presence` (do not rename)  
**Requires:** Orca `>=1.4.0`, Discord **desktop** client (on the Orca host **or** a Windows companion)  
**Author:** Jonathan Marien  
**Version:** 0.3.0

Browser Discord has **no** IPC socket. Presence will never appear if only the web client is open.

Deeper notes: [Architecture](docs/architecture.md) · [Privacy](docs/privacy.md) · [Roadmap](ROADMAP.md)

---

## What it does

The plugin is a trusted Orca worker (`dist/main.js`) that:

1. Reads workspace context (`displayName`, `branch`, terminal count) and agent status events.
2. Applies privacy gates (detail level + per-field toggles).
3. Writes a Discord Rich Presence activity to the **local** Discord desktop IPC socket when one is available.
4. If local IPC is down and the opt-in **companion bridge** is enabled, POSTs the same privacy-gated activity to a Windows (or other) companion that calls `SET_ACTIVITY` there.
5. Debounces writes to Discord’s `SET_ACTIVITY` rate limit (at most one update per 15 seconds).
6. Heartbeats every 90 seconds so the worker is not idle-reaped and so branch switches (which emit no event) are picked up.

No Discord developer account is required for end users. The plugin ships its own Discord Application ID. There is **no bot token and no client secret**.

Orca loads `dist/main.js` (see `orca-plugin.json` `main`). That file is Node/Electron-compatible ESM — you do **not** need Bun installed to *run* the plugin.

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

Changing the Application ID requires a plugin release. v0.2 has no user-facing override UI (v1.0 may add a settings panel). The id lives in [`src/presence/settings.ts`](src/presence/settings.ts) as `SHIPPED_APPLICATION_ID`. Rebuild `dist/` after changing it.

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
| `notifications:show` | **Show Status** toast |

No `secrets` capability. No terminal write.

### 4. Confirm it is alive

Run **Discord Presence: Show Status** from the command palette. Presence starts on the first agent event, worktree event, command, or 90 s heartbeat — not necessarily at bare app launch.

Keep the Discord **desktop** client signed in and running.

---

## Commands

Panels cannot call `settings.set` in Orca’s current host API, so each toggle is a command:

| Command | Effect |
|---|---|
| Discord Presence: Enable/Disable | Master switch (`enabled`) |
| Discord Presence: Show Status | Notification + log of connection and last activity |
| Discord Presence: Cycle Detail Level | `off` → `generic` → `workspace` → `full` → … |
| Discord Presence: Toggle Branch | `showBranch` |
| Discord Presence: Toggle Agent State | `showAgentState` |
| Discord Presence: Toggle Terminal Count | `showTerminals` |
| Discord Presence: Toggle Machine Name | `showMachine` |
| Discord Presence: Toggle Elapsed Timer | `showElapsed` |
| Discord Presence: Toggle Bridge | `bridgeEnabled` (still needs `bridgeUrl` / token) |

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
src/discord/client.ts       handshake, SET_ACTIVITY, ping/pong, teardown
src/presence/settings.ts    defaults, normalize, detail-level cycle, field toggles
src/presence/activity.ts    privacy-gated activity builder (the disclosure boundary)
src/presence/controller.ts  snapshot cache, 15 s debounce, local-then-bridge publish
src/presence/bridge.ts      companion URL/token hygiene + HTTP client
companion/                  Windows (or any OS) HTTP → local Discord IPC
dist/main.js                Orca entry (bundled Node ESM)
```

| Concern | Module |
|---|---|
| Host lifecycle | `src/main.ts` — `export default activate`, `export function deactivate` |
| IPC paths + framing | `src/discord/ipc.ts` |
| RPC session | `src/discord/client.ts` |
| Settings shape | `src/presence/settings.ts` |
| What Discord sees | `src/presence/activity.ts` |
| When Discord is written | `src/presence/controller.ts` (prefer local IPC, else opt-in bridge) |
| Companion HTTP client | `src/presence/bridge.ts` |
| Windows companion server | `companion/main.ts` |

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
| `bun run companion` | Starts the Windows/local companion (`companion/main.ts`) |
| `bun run companion:compile` | Optional standalone binary (`companion/orca-presence-companion`) |

`bun run build` emits Node-compatible ESM at `dist/main.js`. Commit that file when the TypeScript sources change so `devPluginPaths` and marketplace installs work without a local build.

Zero production dependencies. Hand-rolled Discord IPC (same approach as Burpcord). Dev-only deps are TypeScript and `@types/bun`.

TypeScript sources carry JSDoc (`@module`, `@author Jonathan Marien`, `@date`) on modules and significant exports.

---

## Omarchy host → Windows Discord (companion)

Local Discord IPC cannot cross machines. If Orca (and this plugin) run on **Omarchy** but Discord / Vencord is signed in on **Windows**, use the opt-in HTTP bridge plus the Windows companion.

**Publish policy:** prefer **local Discord IPC** when a desktop client on the Orca host accepts the handshake. If that fails **and** the bridge is enabled, POST the same privacy-gated activity to the companion. The plugin does **not** dual-publish. Switching from bridge back to local IPC clears the remote activity.

This is the [#3](https://github.com/jondmarien/orca-discord-presence/issues/3) **plugin MVP**. It does not change Orca core. A native Orca remote-presence / host-mediated API is still future work — [ROADMAP.md](ROADMAP.md).

### 1. Windows companion

On the Windows machine (Discord or Vencord running, signed in):

```powershell
# from the repository root (Bun 1.4+)
bun install
bun run companion
```

Or, from `companion/`:

```powershell
bun run start
```

Defaults: bind `127.0.0.1:3848` (loopback only; token optional).

To accept traffic from Omarchy over Tailscale or LAN:

```powershell
$env:ORCA_PRESENCE_BIND = "0.0.0.0"
$env:ORCA_PRESENCE_PORT = "3848"
$env:ORCA_PRESENCE_BRIDGE_TOKEN = "<high-entropy secret>"
bun run companion
```

Optional standalone exe:

```powershell
bun build .\companion\main.ts --compile --outfile .\companion\orca-presence-companion.exe
```

| Env | Default | Notes |
|---|---|---|
| `ORCA_PRESENCE_BIND` | `127.0.0.1` | Use `0.0.0.0` or the Windows Tailscale IP for Omarchy→Windows |
| `ORCA_PRESENCE_PORT` | `3848` | |
| `ORCA_PRESENCE_BRIDGE_TOKEN` | empty | **Required** when bind is not loopback |
| `ORCA_PRESENCE_CLIENT_ID` | shipped Application ID | Same public snowflake as the plugin |

The companion **refuses to start** on a non-loopback bind without a token. It reuses `src/discord/ipc.ts` / `src/discord/client.ts` (no second IPC implementation).

### 2. Tailscale (recommended)

1. Install Tailscale on Omarchy and Windows; both signed in to the same tailnet.
2. Bind the companion to `0.0.0.0` or the Windows Tailscale IP, with a token.
3. Allow inbound TCP `3848` from the Tailscale interface (Windows Firewall).
4. On Omarchy, set `bridgeUrl` to `http://<windows-tailscale-ip>:3848`.

Prefer Tailscale (or another overlay) over opening the port on a public LAN.

### 3. Plugin settings (Omarchy host)

The bridge is **off** by default. Enable it only when you intend to send activity to another machine.

| Setting | Default | Meaning |
|---|---|---|
| `bridgeEnabled` | `false` | Master switch. Palette: **Discord Presence: Toggle Bridge** |
| `bridgeUrl` | `""` | Companion base URL, e.g. `http://100.x.y.z:3848` |
| `bridgeToken` | `""` | Same value as `ORCA_PRESENCE_BRIDGE_TOKEN`. Required when the URL host is not loopback |

There is no settings panel in v0.3. Persist `bridgeUrl` and `bridgeToken` through the plugin `settings:own` store, or overlay them at worker start:

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
| Status says `connected=false` | Desktop client not running, or IPC socket not found | Start Discord desktop; wait ≤90 s for the heartbeat retry |
| Presence vanished after ~5 minutes idle | Worker idle-reap (no host calls) | Heartbeat should prevent this; confirm the plugin is still enabled |
| Stale branch on the profile | Branch switches emit no host event | Wait for the 90 s heartbeat, or run **Show Status** / any toggle |
| Presence lags during agent tool-use | Discord rate limit | Expected: at most one `SET_ACTIVITY` per 15 s; newest state wins |
| Linux worker cannot find the socket | `XDG_RUNTIME_DIR` stripped from the worker env | Plugin reconstructs `/run/user/<uid>/` and Flatpak/Snap nests |
| Vesktop Flatpak + arRPC, no presence | Socket is inside the Vesktop sandbox, not at `$XDG_RUNTIME_DIR/discord-ipc-0` | Enable **Rich Presence via arRPC** in Vesktop. The plugin also probes `$XDG_RUNTIME_DIR/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-*` (and `/run/user/<uid>/…` when XDG is missing). Keep the desktop client running. |
| Omarchy agents + Windows Discord, no presence | Local IPC cannot cross machines; bridge off by default | Enable the companion on Windows and `bridgeEnabled` on the host — see [Omarchy → Windows](#omarchy-host--windows-discord-companion) |
| Wrong / missing art | Assets not yet propagated, or wrong Application ID | Confirm keys `orca`, `state-working`, `state-blocked`, `state-waiting`, `state-idle` |
| `activate` killed at startup | Handshake blocked the ready timeout | First refresh is fire-and-forget; if you changed that, restore it |

**Show Status** logs `enabled=… connected=… sink=… bridge=… detail=… transmitting=…` — that JSON is exactly what was last sent (or `null` if cleared). The token is never logged.

---

## Known limits

- No file-level presence (Orca host API v0 exposes none).
- Machine name is the **Orca client** hostname (`os.hostname()` in the plugin worker), not an SSH remote host.
- Local Discord IPC still cannot leave the host. The **opt-in companion** ([#3](https://github.com/jondmarien/orca-discord-presence/issues/3) plugin MVP) is the supported Omarchy→Windows path; a native Orca remote-presence API is still future work — [ROADMAP.md](ROADMAP.md).
- Installing this plugin on Windows **and** Omarchy still does not, by itself, bridge agent events. The Windows box must run the companion (or be the Orca host with Discord).
- Presence starts on the first agent/worktree event, command, or 90 s heartbeat — not at bare app launch.
- Idle-reap survival depends on a 90 s `workspace.readContext` heartbeat (worker is reaped after 5 minutes of no host calls).
- v0.3 has no settings panel; toggles are commands only. `bridgeUrl` / `bridgeToken` are persisted settings or env overlays.

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
| Dual-host: Omarchy host (no Discord) + Windows companion + bridge on | Presence via Windows `SET_ACTIVITY` ([#3](https://github.com/jondmarien/orca-discord-presence/issues/3) MVP) |
| Dual-host without companion / with `bridgeEnabled: false` | No presence (privacy default) |
| Smoke: Omarchy host + Vesktop signed in (arRPC) + plugin | Presence on the Discord account; visible from Windows Discord/Vencord as profile activity even though Windows is not the IPC publisher |

Manual install/consent/live-presence checks need the desktop client. The Application ID in `src/presence/settings.ts` is already the shipped snowflake.
