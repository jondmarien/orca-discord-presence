# Architecture

Author: Jonathan Marien  
Date: 2026-11-04

This note describes how `jondmarien.discord-presence` is wired. Runtime behavior is implemented in TypeScript under `src/`; Orca loads the bundled Node ESM at `dist/main.js`.

## Process model

Orca starts a trusted plugin worker and calls `export default function activate(orca)`. An optional `export function deactivate()` runs on shutdown.

`activate` must return inside the host ready timeout (~10 s). Connecting to Discord can take a socket scan plus a 5 s handshake, so the first workspace refresh is **fire-and-forget**. Presence is therefore not guaranteed at the instant activate resolves.

The worker is **idle-reaped after 5 minutes** of no host calls. An open Discord socket does not count as activity. A 90 s `workspace.readContext` heartbeat (`HEARTBEAT_MS` in `src/main.ts`) both keeps the worker alive and picks up branch changes, which emit no event.

Manifest-declared events (`agent.status.changed`, `workspace.changed`, `workspace.removed`) also wake a sleeping worker. Dynamic-only subscriptions would not. There is **no** focused-window or active-tab event in the stock host API.

## Where the worker runs

Paired Orca clients and `orca serve` run plugins on the host, not on the client. When Windows controls a Linux Orca, the worker runs on Linux; with `orca serve` it runs on the SSH server. Discord's IPC socket or pipe exists only on the machine where Discord runs, so a worker on a different machine publishes through the companion bridge. Vesktop on the same Linux host as the worker uses local IPC.

| Setup | Worker runs on | Discord path |
|---|---|---|
| Local desktop | That desktop | Local IPC |
| Linux host with Vesktop, controlled remotely | Linux host | Local IPC on the host |
| Linux host, Discord on Windows | Linux host | Companion on Windows |
| `orca serve` on an SSH server | SSH server | Companion next to Discord |

## Module map

```
activate (src/main.ts)
  ├─ normalizeSettings(settings.get) + bridge token from secrets (settings fallback) + applyBridgeEnvOverrides
  ├─ agents.list → seed agent table (when the host has it)
  ├─ settings.onDidChange → re-read settings → controller.setSettings (no reload)
  ├─ createDiagnosticSink (orca.log + state-dir file)
  ├─ createDiscordClient({ clientId: applicationId })
  ├─ createBridgeTransport()
  ├─ createPresenceController({ client, bridge, settings, diagnostics })
  ├─ commands → persist (settings.set) → controller.setSettings → refresh
  ├─ presence.configure → applyConfigure (fail-fast) → persist; App ID change recreates the IPC client
  ├─ presence.clear → controller.clear (hold; heartbeat does not republish)
  ├─ presence.reload → refresh → controller.reload (close + reconnect + SET_ACTIVITY)
  ├─ agent.status.changed → agent table → aggregate → update
  ├─ events / heartbeat → workspace.readContext (or minimal snapshot) → update + forceTransmit on heartbeat/status (heartbeat does not lift Clear)
  ├─ panels.handle('presence.snapshot' / 'presence.run') + panels.post('presence.snapshot', redacted snapshot)
  └─ deactivate → controller.stop → clear local + remote + close socket (idempotent)
```

| Path | Role |
|---|---|
| [`src/main.ts`](../src/main.ts) | Host wiring only. No Discord framing, no activity field policy. |
| [`src/discord/ipc.ts`](../src/discord/ipc.ts) | Pure path table + frame encode/decode. Shared with the companion. |
| [`src/discord/client.ts`](../src/discord/client.ts) | The only module that opens a `node:net` Discord socket (plugin + companion). Handshake retry + clear-before-close. |
| [`src/discord/retry.ts`](../src/discord/retry.ts) | Capped exponential backoff (3 tries, 3s→15s) and retryable vs fatal errors. |
| [`src/discord/app-id.ts`](../src/discord/app-id.ts) | Fail-fast snowflake validation; shipped id always accepted. |
| [`src/presence/settings.ts`](../src/presence/settings.ts) | Defaults, coerce-from-storage, cycle/toggle helpers. |
| [`src/presence/activity.ts`](../src/presence/activity.ts) | **Privacy boundary.** Snapshot + settings → activity or `null`. |
| [`src/presence/controller.ts`](../src/presence/controller.ts) | Snapshot merge, 15 s debounce, reconnect, **local-then-bridge** publish, **Reload RPC**. |
| [`src/presence/expiry.ts`](../src/presence/expiry.ts) | `AGENT_RETENTION_MS` (30m stale / 60s done) plus older 30s/60s helpers for future focus/tool providers ([#7](https://github.com/jondmarien/orca-discord-presence/issues/7)). |
| [`src/presence/agent-state.ts`](../src/presence/agent-state.ts) | Alias table → `working` / `blocked` / `waiting` / `done`. |
| [`src/presence/agents.ts`](../src/presence/agents.ts) | Multi-agent table. Seeded from `agents.list`, updated by `agent.status.changed`; one entry per terminal. |
| [`src/presence/configure.ts`](../src/presence/configure.ts) | Fail-fast `applyConfigure` for Application ID / `openUrl` / toggles / `bridgeToken`. |
| [`src/presence/bridge-token.ts`](../src/presence/bridge-token.ts) | Bridge token in Orca secrets; plugin-settings fallback with a warning when no keyring is available. |
| [`src/presence/bridge.ts`](../src/presence/bridge.ts) | Companion URL/token hygiene + `POST`/`DELETE /activity`. |
| [`src/presence/log.ts`](../src/presence/log.ts) | Structured `orca.log` + capped state-dir file. Optional `onEmit` feeds the panel ring. |
| [`src/presence/log-ring.ts`](../src/presence/log-ring.ts) | Bounded in-memory tail for the sidebar snapshot. |
| [`src/presence/panel-snapshot.ts`](../src/presence/panel-snapshot.ts) | Redacted panel JSON (no App ID, no token, no bridge URL). |
| [`panel/index.html`](../panel/index.html) | Sidebar UI. Talks to the worker through `window.orca.plugin.request`. |
| [`companion/`](../companion/) | OS-agnostic HTTP listener → same Discord IPC client (Linux/macOS/Windows). |

Tests live under `test/` and use Bun’s test runner. Client tests stand up a fake IPC server; controller tests inject a fake clock and client.

## Discord IPC (high level)

Discord desktop listens on up to ten endpoints: `discord-ipc-0` … `discord-ipc-9`.

- **Windows:** named pipes `\\?\pipe\discord-ipc-N`.
- **POSIX:** Unix sockets under `XDG_RUNTIME_DIR`, `/run/user/<uid>`, `TMPDIR` / `TMP` / `TEMP`, then `/tmp`. Official Discord Flatpak (`app/com.discordapp.Discord`) and Snap (`snap.discord`) nest one directory deeper. Vesktop Flatpak + arRPC uses `.flatpak/dev.vencord.Vesktop/xdg-run`. Plain `discord-ipc-N` is still tried first.

Orca’s worker env allowlist **drops** `XDG_RUNTIME_DIR`. On Linux the plugin reconstructs `/run/user/<uid>` from `os.userInfo().uid`.

Each frame is:

```
[int32LE opcode][int32LE jsonByteLength][utf8 JSON]
```

| Opcode | Name | Use |
|---|---|---|
| 0 | HANDSHAKE | `{ v: 1, client_id }` |
| 1 | FRAME | RPC commands (`SET_ACTIVITY`) and dispatches (`READY`, `ERROR`) |
| 2 | CLOSE | Peer hangup |
| 3 | PING | Heartbeat from Discord |
| 4 | PONG | Reply to PING |

Handshake waits up to 5 s for `evt: READY`. `READY` with a **null / missing `data`** is retryable (Discord accepted the pipe before the user session is ready — a race seen in a prior Discord RPC integration). Handshake timeout is also retryable. The client tries up to **3** times with capped exponential backoff (**3s → 15s**). A missing IPC socket is **not** retried so the companion bridge can fail over immediately. An obvious bad Application ID (not a 17–20 digit snowflake) or a 404 / “not found” handshake error fails fast and is not retried.

Commands carry a UUID `nonce` and wait up to 5 s for a matching reply. Declared body lengths over 1 MiB are rejected so a desynced stream cannot grow the buffer without bound.

`SET_ACTIVITY` args are `{ pid: process.pid, activity }` or `{ pid, activity: null }` to clear. `close()` / `stop()` / `deactivate()` send **null first** (ghost “Playing Orca” fix) and are **idempotent**.

## Debounce and reconnect

`MIN_UPDATE_INTERVAL_MS` is 15_000. The first transmit after a quiet period goes through immediately. Further `update()` calls inside the window schedule **one** deferred write of the **latest** merged snapshot (not a replay of every state).

If the rendered activity JSON equals the last successful send, `update()` skips the write so a chatty event stream is cheap. **Heartbeat and Show Status call `forceTransmit()`**, which re-sends even when unchanged — Discord or another IPC client can replace our activity after we recorded a successful send. **Reload RPC** (`controller.reload()`) closes the socket (clear-before-close), reconnects with the handshake retry policy, and force-transmits.

A missing `workspace.readContext` still applies a minimal snapshot so `detailLevel: generic` can publish `Working in Orca`.

Connect failures (Discord not running) are logged and swallowed. The next `update` or heartbeat retries. If local IPC is down and `resolveBridgeTarget` is set, the controller POSTs to the companion instead of giving up. It does **not** write both sinks. A successful later local handshake clears the remote activity.

A user command that changes settings bypasses the debounce so the palette feels immediate.

`stop()` / disable / `detailLevel: 'off'` clear presence **once** (no duplicate `activity: null` spam), including `DELETE /activity` when the last sink was the bridge. A second `stop()` / `deactivate()` is a no-op.

## Sidebar panel

`orca-plugin.json` contributes one panel (`id: presence`, title `Rich Presence`, `panel/index.html`). The host loads it in a sandboxed iframe.

The panel uses the stock plugin frame API:

- `window.orca.plugin.request('presence.snapshot')` returns a redacted snapshot (status, settings summary, log tail).
- `window.orca.plugin.request('presence.run', { command })` runs one of the plugin's commands.
- The worker pushes updates with `panels.post('presence.snapshot', snapshot)`, coalesced during chatty agent events. The panel listens with `orca.plugin.on('presence.snapshot', ...)`.

The worker registers the handlers with `panels.handle` only when the host has it. Outside the Orca desktop app (for example a browser client without `plugin.request`) the panel hides its UI and shows a static note, "Open this panel in the Orca desktop app to see live status." The snapshot never contains the Application ID, bridge URL, bridge token, or button URL. The panel does not rewrite its own HTML.

## Activity expiry (future providers)

[`src/presence/expiry.ts`](../src/presence/expiry.ts) exports `AGENT_RETENTION_MS` (`stale` 30 minutes, `done` 60 seconds) for the live agent table, plus `ACTIVITY_EXPIRY_MS` (`short` 30s, `long` 60s) and `isActivityFresh()` for a future focus/tool path. This plugin does **not** rotate providers yet. When [#7](https://github.com/jondmarien/orca-discord-presence/issues/7) (focused window/tab) lands, providers should reuse `isActivityFresh` instead of inventing a new clock.

**Clear:** `presence.clear` sends `SET_ACTIVITY` null (and companion `DELETE` when that was the last sink) without flipping `enabled`. Automatic republish is held. The heartbeat does not lift the hold. The next `agent.status.changed`, Show Status, Reload RPC, or settings write does.

## Activity fields

Produced by `buildActivity` in `src/presence/activity.ts`:

| JSON field | Source |
|---|---|
| `details` | `"Working in Orca"`, workspace name, or `name — branch` |
| `state` | `N agent(s) · label · N terminals · machine` (omitted if empty) |
| `timestamps.start` | `min(stateStartedAtMs, now)` as Unix **seconds** |
| `assets.large_image` | always `orca` when an activity exists |
| `assets.small_image` | `state-working` / `state-blocked` / `state-waiting` / `state-idle` |
| `buttons` | at most one `{ label, url }` when `showOpenButton` + HTTPS `openUrl` |

Text fields are clamped to 128 characters. See [privacy.md](privacy.md) for which settings unlock which strings.

## Build and runtime

- **Authoring / CI:** Bun (`bun install`, `bun test`, `bun run typecheck`, `bun run build`).
- **Runtime:** Node/Electron plugin worker. `dist/main.js` must stay free of `Bun.file` / `Bun.spawn`.
- **Identity:** install id `jondmarien.discord-presence` (manifest `id: discord-presence`, no `publisher`; the host derives it from the repo owner). Manifest v2, `execution: trusted-worker`, `engines.orca >= 1.4.248`. Settings are declared in `contributes.settings`.
- **Capabilities:** `workspace:read`, `agent:read`, `storage:own`, `settings:own`, `secrets:own`, `notifications:show`.
- **Logs:** state-dir file under `jondmarien-discord-presence/plugin.log` (override `ORCA_PRESENCE_LOG_FILE`). `ORCA_PRESENCE_DISCORD_IPC` overrides the Discord IPC path.
- **Companion:** runs from source with `bun run companion` (or `bun run start` in `companion/`) on Linux, macOS, or Windows. A compiled binary (`bun run companion:compile`) is optional, local only, and never committed. Zero extra production dependencies; Node `http` + shared IPC modules.
- **Focus:** the worker does not subscribe to UI focus/tab events (stock Orca exposes none). Snapshot sources are `agents.list`, `agent.status.changed`, `workspace.changed` and `workspace.readContext`.
