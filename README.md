# Discord Rich Presence for Orca

Shows your current Orca workspace, branch, and agent state as Discord Rich Presence.

Every identifying field is opt-in; the default detail level (`generic`) never transmits a repo, branch, or machine name.

**Plugin id:** `d-sports.discord-presence`  
**Requires:** Orca `>=1.4.0`, Discord **desktop** client (browser Discord has no IPC socket)

## Install

1. Enable the plugin system in Orca (`pluginSystemEnabled: true`).
2. Load this repo as a dev plugin via `devPluginPaths`, or install from a marketplace that lists `d-sports.discord-presence`.
3. Approve the consent dialog (workspace read, events, storage, own settings, notifications).
4. Run **Discord Presence: Show Status** from the command palette. Presence starts on the first agent event, worktree event, command, or heartbeat — not necessarily at app launch.

No Discord developer account is required for end users. The plugin ships its own Discord Application ID.

Orca loads `dist/main.js` (see `orca-plugin.json` `main`). That file is Node/Electron-compatible ESM — you do **not** need Bun installed to run the plugin.

## Discord Application ID (maintainers)

The plugin ships Application ID `1545653843239374848`. The Discord Developer Portal already has this application and the five Rich Presence art assets uploaded:

| Asset key | Use |
|---|---|
| `orca` | Large image |
| `state-working` | Small image |
| `state-blocked` | Small image |
| `state-waiting` | Small image |
| `state-idle` | Small image |

Source copies of those PNGs live in [`assets/`](assets/). Changing the Application ID requires a plugin release (v0.2 has no user-facing override; v1.0 will add one with a settings panel).

**Where the ID lives:** [`src/presence/settings.ts`](src/presence/settings.ts) (`SHIPPED_APPLICATION_ID`). Rebuild `dist/` after changing it.

There is **no Discord bot token or client secret** in this plugin. The Application ID is public data (it appears in every presence payload).

## What is transmitted

Workspace names, branch names, and machine names — when you enable them — are sent to Discord's servers and rendered publicly on your profile. Client repository names can identify clients.

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
| `generic` | Non-identifying "Working in Orca" + optional agent state / terminals / elapsed |
| `workspace` | Workspace display name; still no branch |
| `full` | Workspace + optional branch, machine, etc. |

## Commands

Panels cannot call `settings.set` in Orca's current host API, so each toggle is a command:

| Command | Effect |
|---|---|
| Discord Presence: Enable/Disable | Master switch |
| Discord Presence: Show Status | Notification + log of what is transmitting |
| Discord Presence: Cycle Detail Level | `off` → `generic` → `workspace` → `full` → … |
| Discord Presence: Toggle Branch | `showBranch` |
| Discord Presence: Toggle Agent State | `showAgentState` |
| Discord Presence: Toggle Terminal Count | `showTerminals` |
| Discord Presence: Toggle Machine Name | `showMachine` |
| Discord Presence: Toggle Elapsed Timer | `showElapsed` |

## Privacy

- Defaults are privacy-first: `detailLevel: generic`, branch/machine/terminals off, agent state and elapsed on.
- No secrets capability; no bot token; no client secret.
- Presence is written only to the local Discord desktop IPC socket.

## Known limits

- No file-level presence (Orca host API v0 exposes none).
- Machine name is the **Orca client** hostname (`os.hostname()` in the plugin worker), not an SSH remote host.
- Requires the Discord desktop client.
- Presence starts on the first agent/worktree event, command, or 90 s heartbeat — not at bare app launch.
- Idle-reap survival depends on a 90 s `workspace.readContext` heartbeat (worker is reaped after 5 minutes of no host calls).

## Development

Bun is the package manager, test runner, and (optional) build tool. **Orca's plugin worker is Electron/Node**, not Bun — shipped code uses only `node:*` APIs (`net`, `os`, `crypto`, timers). Do not call `Bun.file` or other Bun-only APIs on the Discord IPC path.

```bash
bun install
bun test
bun run typecheck
bun run build
```

`bun run build` emits Node-compatible ESM at `dist/main.js`. Commit that file when the TypeScript sources change so `devPluginPaths` and marketplace installs work without a local build.

Zero production dependencies. Hand-rolled Discord IPC (same approach as Burpcord). Dev-only deps are TypeScript types.

### Layout

```
src/main.ts                 activate / deactivate + command wiring
src/discord/ipc.ts          socket path candidates + frame codec
src/discord/client.ts       handshake, SET_ACTIVITY, reconnect seams
src/presence/settings.ts    defaults, normalize, detail-level cycle
src/presence/activity.ts    privacy-gated activity builder
src/presence/controller.ts  snapshot cache, 15 s debounce, enable/disable
dist/main.js                Orca entry (bundled Node ESM)
```

## Verification matrix

| Check | Expected |
|---|---|
| Unit suite | `bun test` all pass (fake IPC for client tests) |
| Idle 7+ minutes with desktop client open | Presence still live (heartbeat) |
| Quit then restart desktop client | Silent degrade; returns within one heartbeat (<=90 s) |
| Agent tool-use burst | At most one SET_ACTIVITY per 15 s |
| Linux env-stripped worker | Socket via /run/user/<uid>/ (and Flatpak/Snap nests) |
| SSH workspace | Presence reflects workspace; machine name if enabled is local |

Manual install/consent/live-presence checks need the desktop client. The Application ID in `src/presence/settings.ts` is already the shipped snowflake.
