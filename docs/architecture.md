# Architecture

Author: Jonathan Marien  
Date: 2026-09-05

This note describes how `chron0.discord-presence` is wired. Runtime behavior is implemented in TypeScript under `src/`; Orca loads the bundled Node ESM at `dist/main.js`.

## Process model

Orca starts a trusted plugin worker and calls `export default function activate(orca)`. An optional `export function deactivate()` runs on shutdown.

`activate` must return inside the host ready timeout (~10 s). Connecting to Discord can take a socket scan plus a 5 s handshake, so the first workspace refresh is **fire-and-forget**. Presence is therefore not guaranteed at the instant activate resolves.

The worker is **idle-reaped after 5 minutes** of no host calls. An open Discord socket does not count as activity. A 90 s `workspace.readContext` heartbeat (`HEARTBEAT_MS` in `src/main.ts`) both keeps the worker alive and picks up branch changes, which emit no event.

Manifest-declared events (`agent.status.changed`, `worktree.created`, `worktree.removed`, `ui.focus.changed`) also wake a sleeping worker. Dynamic-only subscriptions would not. Stock `stablyai/orca` rejects `ui.focus.changed` / `ui:focus` / `sidecar`; this 0.6.2 line targets [`jondmarien/orca`](https://github.com/jondmarien/orca).

## Module map

```
activate (src/main.ts)
  ├─ normalizeSettings(settings.get) + applyBridgeEnvOverrides
  ├─ createDiagnosticSink (orca.log + state-dir file)
  ├─ createDiscordClient({ clientId: applicationId })
  ├─ createBridgeTransport()
  ├─ createPresenceController({ client, bridge, sidecar, settings, diagnostics })
  ├─ commands → persist (settings.set) → controller.setSettings → refresh
  ├─ 5 s settings.get poll so panel writes apply
  ├─ presence.configure → applyConfigure (fail-fast) → persist; App ID change recreates the IPC client
  ├─ presence.clear → controller.clear (hold; heartbeat does not republish)
  ├─ presence.reload → refresh → controller.reload (close + reconnect + SET_ACTIVITY)
  ├─ agent.status.changed → agent table (worktreeId + paneKey + optional identity) → aggregate → update
  ├─ ui.focus.changed → validate kind + optional join keys → merge focus fields (null clears focus only)
  ├─ events / heartbeat → workspace.readContext (execution host / agent / focus) → try-call ui.readFocus when the context key is absent → update + forceTransmit on heartbeat/status (heartbeat does not lift Clear)
  ├─ panel snapshot → log ring + redacted JSON in storage (`diagnostics.snapshot`) and panel/index.html
  └─ deactivate → controller.stop → clear local + sidecar + remote + close socket (idempotent)
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
| [`src/presence/controller.ts`](../src/presence/controller.ts) | Snapshot merge, 15 s debounce, reconnect, **local → sidecar mailbox → bridge** publish, **Reload RPC**. |
| [`src/presence/host-context.ts`](../src/presence/host-context.ts) | Parse `executionHost` / `agent` / `focusedSurface` (including optional join keys) from `readContext`. |
| [`src/presence/focus.ts`](../src/presence/focus.ts) | `ui.focus.changed` / `ui.readFocus` parse + privacy-gated labels. Join keys never enter Discord copy. |
| [`src/presence/sidecar.ts`](../src/presence/sidecar.ts) | Try-call `sidecar.resolvePlacement` / `sidecar.publish`. |
| [`src/presence/diagnostics-store.ts`](../src/presence/diagnostics-store.ts) | Cap + write `diagnostics.snapshot`. |
| [`src/presence/panel-live.ts`](../src/presence/panel-live.ts) | Live-poll policy: skip HTML rewrite when storage works; panel JS mirrors this so polls do not reset Settings. |
| [`src/presence/expiry.ts`](../src/presence/expiry.ts) | `AGENT_RETENTION_MS` (30m stale / 60s done) plus older 30s/60s helpers for future focus/tool providers ([#7](https://github.com/jondmarien/orca-discord-presence/issues/7)). |
| [`src/presence/agent-state.ts`](../src/presence/agent-state.ts) | Alias table → `working` / `blocked` / `waiting` / `done`. |
| [`src/presence/agents.ts`](../src/presence/agents.ts) | Multi-agent table keyed by `worktreeId` + `paneKey`. Identity can join optional focus keys; count/state stay global. |
| [`src/presence/configure.ts`](../src/presence/configure.ts) | Fail-fast `applyConfigure` for Application ID / `openUrl` / toggles. |
| [`src/presence/bridge.ts`](../src/presence/bridge.ts) | Companion URL/token hygiene + `POST`/`DELETE /activity`. |
| [`src/presence/log.ts`](../src/presence/log.ts) | Structured `orca.log` + capped state-dir file. Optional `onEmit` feeds the panel ring. |
| [`src/presence/log-ring.ts`](../src/presence/log-ring.ts) | Bounded in-memory tail for the sidebar snapshot. |
| [`src/presence/panel-snapshot.ts`](../src/presence/panel-snapshot.ts) | Redacted panel JSON (no App ID, no token, no bridge URL). |
| [`src/presence/panel-html.ts`](../src/presence/panel-html.ts) | Embed / write `panel/index.html` when the install is writable. |
| [`panel/index.html`](../panel/index.html) | Sandboxed sidebar UI. Official `orca-panel-action` bridge only. |
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

Connect failures (Discord not running) are logged and swallowed. The next `update` or heartbeat retries. If local IPC is down, the controller try-calls `sidecar.resolvePlacement` and may store a mailbox frame. If `resolveBridgeTarget` is set, it also POSTs to the companion (UI Discord IPC may still be `not-implemented` — that is not dual Discord). It does **not** write local IPC and companion together. A successful later local handshake clears the remote activity and any stored sidecar frame.

A user command that changes settings bypasses the debounce so the palette feels immediate.

`stop()` / disable / `detailLevel: 'off'` clear presence **once** (no duplicate `activity: null` spam), including `DELETE /activity` when the last sink was the bridge. A second `stop()` / `deactivate()` is a no-op.

## Sidebar panel

`orca-plugin.json` contributes one panel (`id: presence`, Lucide `settings`, `panel/index.html`). The host loads that HTML in a sandboxed iframe (`plugin:chron0.discord-presence/presence`).

The panel talks to the host only through `postMessage`:

- `{ type: 'orca-panel-action', requestId, action, params }` → `workspace.readContext`, `notifications.show`, optional `ui.readFocus`, and on the fork `settings.get` / `settings.set` / `storage.get`
- `{ type: 'orca-panel-action-result', requestId, ok, value?, error? }`
- Watchdog: `orca-panel-ping` / `orca-panel-pong`

The worker writes a redacted snapshot to `storage.set` (`diagnostics.snapshot`). The panel polls that mailbox for status and logs without re-applying field toggles or forcing Extension Logs open. The worker rewrites `#presence-snapshot` in `panel/index.html` only when storage is unavailable (stock / method miss). When a rewrite does happen it stamps `#plugin-version`, `#version-badge`, and About from `PLUGIN_VERSION`.

## Activity expiry (future providers)

[`src/presence/expiry.ts`](../src/presence/expiry.ts) exports `AGENT_RETENTION_MS` (`stale` 30 minutes, `done` 60 seconds) for the live agent table. Focused-surface samples use `ACTIVITY_EXPIRY_MS.long` (60 s).

**Clear:** `presence.clear` sends `SET_ACTIVITY` null (and companion `DELETE` when that was the last sink) without flipping `enabled`. Automatic republish is held. The heartbeat does not lift the hold. The next `agent.status.changed`, Show Status, Reload RPC, or settings write does.

## Activity fields

Produced by `buildActivity` in `src/presence/activity.ts`:

| JSON field | Source |
|---|---|
| `details` | `"Working in Orca"`, workspace name, or `name — branch` |
| `state` | `focus · agent type/model/profile · N agent(s) · label · N terminals · machine` (omitted if empty) |
| `timestamps.start` | `min(stateStartedAtMs, now)` as Unix **seconds** |
| `assets.large_image` | always `orca` when an activity exists |
| `assets.small_image` | `state-working` / `state-blocked` / `state-waiting` / `state-idle` |
| `buttons` | at most one `{ label, url }` when `showOpenButton` + HTTPS `openUrl` |

Text fields are clamped to 128 characters. See [privacy.md](privacy.md) for which settings unlock which strings.

## Build and runtime

- **Authoring / CI:** Bun (`bun install`, `bun test`, `bun run typecheck`, `bun run build`).
- **Runtime:** Node/Electron plugin worker. `dist/main.js` must stay free of `Bun.file` / `Bun.spawn`.
- **Identity:** `orca-plugin.json` `publisher` + `id` → `chron0.discord-presence`. Do not rename.
- **Panel:** `contributes.panels[0]` id `presence`, sidebar key `plugin:chron0.discord-presence/presence`. The iframe replies to `orca-panel-ping` with `orca-panel-pong`. On the fork it also calls `settings.*` and `storage.get`.
- **Companion:** `bun run companion` / `bun run start` in `companion/`. Runs on Linux, macOS, or Windows. Optional `bun build companion/main.ts --compile`. Zero extra production dependencies; Node `http` + shared IPC modules.
- **Focus:** subscribe to `ui.focus.changed` (requires `ui:focus`). Try-call `ui.readFocus` when `readContext` omits `focusedSurface`. Unknown kinds are dropped. Explicit `null` clears focus fields only. Optional `worktreeId` / `agentId` on the surface are join keys only — never transmitted, never rendered as text. `agentId` is kept only when `kind === 'agent'` (same as the host projection). Remote UI focus is sampled on the UI machine and forwarded via `plugins.reportUiFocus` ([jondmarien/orca#8](https://github.com/jondmarien/orca/pull/8) on fork `main` @ [`096f26bd`](https://github.com/jondmarien/orca/commit/096f26bdf5b2e1cb378c429716bc2d82c1426a9d)); the plugin sees the same projection.
