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

## Discord Application ID (maintainers)

Until a real Discord application exists, the default is the literal placeholder:

```text
1545653843239374848
```

**Where to plug it in:**

1. Create an application at the Discord developer portal (name it **Orca** — that string is the game name Discord shows).
2. Copy the Application ID (a 17–20 digit snowflake).
3. Application ID is already set to `1545653843239374848` in [`src/presence-settings.mjs`](src/presence-settings.mjs).
4. Under Rich Presence → Art Assets, upload five 512×512 PNGs with keys: `orca`, `state-working`, `state-blocked`, `state-waiting`, `state-idle`.
5. Ship a new plugin release. Changing the ID requires a release (v0.1 has no user-facing override; v1.0 will add one with a settings panel).

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

```bash
node --test test/
```

Zero runtime package dependencies. All modules are ESM (`.mjs`).

## Verification matrix


| Check | Expected |
|---|---|
| Unit suite | All pass (fake IPC for client tests) |
| Idle 7+ minutes with desktop client open | Presence still live (heartbeat) |
| Quit then restart desktop client | Silent degrade; returns within one heartbeat (<=90 s) |
| Agent tool-use burst | At most one SET_ACTIVITY per 15 s |
| Linux env-stripped worker | Socket via /run/user/<uid>/ (and Flatpak/Snap nests) |
| SSH workspace | Presence reflects workspace; machine name if enabled is local |

Manual install/consent/live-presence checks need the desktop client and a real Application ID in src/presence-settings.mjs.
