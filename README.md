# Discord Rich Presence for Orca

Shows your current Orca workspace, branch, and agent state as Discord Rich Presence.

Every identifying field is **opt-in**. The default detail level (`generic`) never transmits a repo, branch, or machine name — only non-identifying copy such as `Working in Orca`, plus optional agent state and an elapsed timer.

**Plugin id:** `chron0.discord-presence`  
**Publisher / id:** `chron0` / `discord-presence` (do not rename)  
**Requires:** Orca `>=1.4.0`, Discord **desktop** client  
**Author:** Jonathan Marien  
**Version:** 0.2.0

Browser Discord has **no** IPC socket. Presence will never appear if only the web client is open.

Deeper notes: [Architecture](docs/architecture.md) · [Privacy](docs/privacy.md)

---

## What it does

The plugin is a trusted Orca worker (`dist/main.js`) that:

1. Reads workspace context (`displayName`, `branch`, terminal count) and agent status events.
2. Applies privacy gates (detail level + per-field toggles).
3. Writes a Discord Rich Presence activity to the **local** Discord desktop IPC socket.
4. Debounces writes to Discord’s `SET_ACTIVITY` rate limit (at most one update per 15 seconds).
5. Heartbeats every 90 seconds so the worker is not idle-reaped and so branch switches (which emit no event) are picked up.

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
src/presence/controller.ts  snapshot cache, 15 s debounce, silent reconnect
dist/main.js                Orca entry (bundled Node ESM)
```

| Concern | Module |
|---|---|
| Host lifecycle | `src/main.ts` — `export default activate`, `export function deactivate` |
| IPC paths + framing | `src/discord/ipc.ts` |
| RPC session | `src/discord/client.ts` |
| Settings shape | `src/presence/settings.ts` |
| What Discord sees | `src/presence/activity.ts` |
| When Discord is written | `src/presence/controller.ts` |

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

`bun run build` emits Node-compatible ESM at `dist/main.js`. Commit that file when the TypeScript sources change so `devPluginPaths` and marketplace installs work without a local build.

Zero production dependencies. Hand-rolled Discord IPC (same approach as Burpcord). Dev-only deps are TypeScript and `@types/bun`.

TypeScript sources carry JSDoc (`@module`, `@author Jonathan Marien`, `@date`) on modules and significant exports.

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
| Wrong / missing art | Assets not yet propagated, or wrong Application ID | Confirm keys `orca`, `state-working`, `state-blocked`, `state-waiting`, `state-idle` |
| `activate` killed at startup | Handshake blocked the ready timeout | First refresh is fire-and-forget; if you changed that, restore it |

**Show Status** logs `enabled=… connected=… detail=… transmitting=…` — that JSON is exactly what was last sent (or `null` if cleared).

---

## Known limits

- No file-level presence (Orca host API v0 exposes none).
- Machine name is the **Orca client** hostname (`os.hostname()` in the plugin worker), not an SSH remote host.
- Requires the Discord desktop client.
- Presence starts on the first agent/worktree event, command, or 90 s heartbeat — not at bare app launch.
- Idle-reap survival depends on a 90 s `workspace.readContext` heartbeat (worker is reaped after 5 minutes of no host calls).
- v0.2 has no settings panel; toggles are commands only.

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

Manual install/consent/live-presence checks need the desktop client. The Application ID in `src/presence/settings.ts` is already the shipped snowflake.
