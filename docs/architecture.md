# Architecture

Author: Jonathan Marien  
Date: 2026-09-05

This note describes how `chron0.discord-presence` is wired. Runtime behavior is implemented in TypeScript under `src/`; Orca loads the bundled Node ESM at `dist/main.js`.

## Process model

Orca starts a trusted plugin worker and calls `export default function activate(orca)`. An optional `export function deactivate()` runs on shutdown.

`activate` must return inside the host ready timeout (~10 s). Connecting to Discord can take a socket scan plus a 5 s handshake, so the first workspace refresh is **fire-and-forget**. Presence is therefore not guaranteed at the instant activate resolves.

The worker is **idle-reaped after 5 minutes** of no host calls. An open Discord socket does not count as activity. A 90 s `workspace.readContext` heartbeat (`HEARTBEAT_MS` in `src/main.ts`) both keeps the worker alive and picks up branch changes, which emit no event.

Manifest-declared events (`agent.status.changed`, `worktree.created`, `worktree.removed`) also wake a sleeping worker. Dynamic-only subscriptions would not.

## Module map

```
activate (src/main.ts)
  ├─ normalizeSettings(settings.get) + applyBridgeEnvOverrides
  ├─ createDiscordClient({ clientId: applicationId })
  ├─ createBridgeTransport()
  ├─ createPresenceController({ client, bridge, settings })
  ├─ commands → persist (settings.set) → controller.setSettings → refresh
  ├─ events / heartbeat → workspace.readContext + os.hostname → controller.update
  └─ deactivate → controller.stop → clear local + remote + close socket
```

| Path | Role |
|---|---|
| [`src/main.ts`](../src/main.ts) | Host wiring only. No Discord framing, no activity field policy. |
| [`src/discord/ipc.ts`](../src/discord/ipc.ts) | Pure path table + frame encode/decode. Shared with the companion. |
| [`src/discord/client.ts`](../src/discord/client.ts) | The only module that opens a `node:net` Discord socket (plugin + companion). |
| [`src/presence/settings.ts`](../src/presence/settings.ts) | Defaults, coerce-from-storage, cycle/toggle helpers. |
| [`src/presence/activity.ts`](../src/presence/activity.ts) | **Privacy boundary.** Snapshot + settings → activity or `null`. |
| [`src/presence/controller.ts`](../src/presence/controller.ts) | Snapshot merge, 15 s debounce, reconnect, **local-then-bridge** publish. |
| [`src/presence/bridge.ts`](../src/presence/bridge.ts) | Companion URL/token hygiene + `POST`/`DELETE /activity`. |
| [`companion/`](../companion/) | Windows (or any OS) HTTP listener → same Discord IPC client. |

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

Handshake waits up to 5 s for `evt: READY`. Commands carry a UUID `nonce` and wait up to 5 s for a matching reply. Declared body lengths over 1 MiB are rejected so a desynced stream cannot grow the buffer without bound.

`SET_ACTIVITY` args are `{ pid: process.pid, activity }` or `{ pid, activity: null }` to clear.

## Debounce and reconnect

`MIN_UPDATE_INTERVAL_MS` is 15_000. The first transmit after a quiet period goes through immediately. Further `update()` calls inside the window schedule **one** deferred write of the **latest** merged snapshot (not a replay of every state).

If the rendered activity JSON equals the last successful send, the controller skips the write entirely.

Connect failures (Discord not running) are logged and swallowed. The next `update` or heartbeat retries. If local IPC is down and `resolveBridgeTarget` is set, the controller POSTs to the companion instead of giving up. It does **not** write both sinks. A successful later local handshake clears the remote activity.

A user command that changes settings bypasses the debounce so the palette feels immediate.

`stop()` / disable / `detailLevel: 'off'` clear presence **once** (no duplicate `activity: null` spam), including `DELETE /activity` when the last sink was the bridge.

## Activity fields

Produced by `buildActivity` in `src/presence/activity.ts`:

| JSON field | Source |
|---|---|
| `details` | `"Working in Orca"`, workspace name, or `name — branch` |
| `state` | `label · N terminals · machine` (omitted if empty) |
| `timestamps.start` | `min(stateStartedAtMs, now)` as Unix **seconds** |
| `assets.large_image` | always `orca` when an activity exists |
| `assets.small_image` | `state-working` / `state-blocked` / `state-waiting` / `state-idle` |

Text fields are clamped to 128 characters. See [privacy.md](privacy.md) for which settings unlock which strings.

## Build and runtime

- **Authoring / CI:** Bun (`bun install`, `bun test`, `bun run typecheck`, `bun run build`).
- **Runtime:** Node/Electron plugin worker. `dist/main.js` must stay free of `Bun.file` / `Bun.spawn`.
- **Identity:** `orca-plugin.json` `publisher` + `id` → `chron0.discord-presence`. Do not rename.
- **Companion:** `bun run companion` / `bun run start` in `companion/`. Optional `bun build companion/main.ts --compile`. Zero extra production dependencies; Node `http` + shared IPC modules.
