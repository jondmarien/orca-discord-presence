# Privacy

Author: Jonathan Marien  
Date: 2026-09-05

`chron0.discord-presence` is privacy-first by default. This note is the disclosure contract: what can leave the machine, what never does, and which setting unlocks each field.

The **only** module that chooses identifying strings is [`src/presence/activity.ts`](../src/presence/activity.ts). The Discord client and controller transmit whatever that builder returns (or clear when it returns `null`). Downstream code does not re-check gates.

## Defaults

From `DEFAULT_SETTINGS` in [`src/presence/settings.ts`](../src/presence/settings.ts):

- Presence **enabled**, detail **`generic`**.
- Branch, machine, and terminal count **off**.
- Agent state and elapsed timer **on**.
- Application id is the shipped public snowflake `1545653843239374848`.

`generic` never includes a workspace display name, git branch, or machine name — even if `showBranch` or `showMachine` were flipped on. Those toggles only take effect at higher detail levels (machine also requires detail ≠ `generic`; branch requires `full`).

## What Discord receives

When an activity is produced, Discord’s servers render it on your profile. That path is:

1. Plugin worker → local Discord desktop IPC socket (`SET_ACTIVITY`).
2. Discord desktop → Discord’s presence service.

There is no plugin-side HTTP client, no analytics, and no third-party host. Browser Discord is not used and cannot receive these writes (no IPC).

| Transmitted | When |
|---|---|
| Application id (public) | Handshake `client_id` |
| Game name `Orca` | Discord application name (portal), not a plugin setting |
| `Working in Orca` | `detailLevel === 'generic'` |
| Workspace display name | `detailLevel` is `workspace` or `full` |
| `name — branch` | `detailLevel === 'full'` **and** `showBranch` **and** a branch exists |
| Agent label (`working`, `blocked`, `waiting for input`, `idle`) | `showAgentState` |
| `N terminal(s)` | `showTerminals` and `terminalCount` is a number |
| Machine name or `machineLabel` | `showMachine` **and** `detailLevel !== 'generic'` |
| Start timestamp (Unix seconds) | `showElapsed` and `stateStartedAtMs` is a number |
| Asset keys `orca`, `state-*` | Any non-null activity |

| Never transmitted |
|---|
| Discord bot token / client secret (this plugin has none) |
| File paths, file names, or editor cursors (host API exposes none) |
| Raw unrecognized agent states (mapped to idle) |
| SSH remote hostnames (`os.hostname()` is the Orca **client**) |
| Extra keys from hand-edited settings JSON |
| A blank `state` string (the field is omitted instead) |

Disable (`enabled: false`) or `detailLevel: 'off'` produce **no** activity; the controller clears an existing one.

## Agent state mapping

Only these Orca states have labels. Anything else becomes idle so a future or malformed state cannot leak:

| Orca state | Label | Asset key |
|---|---|---|
| `working` | working | `state-working` |
| `blocked` | blocked | `state-blocked` |
| `waiting` | waiting for input | `state-waiting` |
| `done` | idle | `state-idle` |
| anything else | idle | `state-idle` |

## Settings hygiene

`normalizeSettings` treats host storage as untrusted:

- Unknown keys are dropped.
- Non-boolean toggles keep the default.
- Unknown detail levels keep `generic`.
- `applicationId` must be 17–20 digits (or exactly the shipped id); otherwise the shipped id is used. It is never normalized to `null`.
- `machineLabel` is trimmed and capped at 64 characters.

Commands persist the full normalized object via `settings.set` (one key per field). There is no settings panel in v0.2.

## Capabilities

The consent dialog lists `workspace:read`, `events:subscribe`, `storage`, `settings:own`, and `notifications:show`. There is no `secrets` capability.

## Operator advice

- Leave detail at `generic` on shared or client-named workspaces unless you intend to publish the name.
- Treat repository / branch names as client-identifying once `full` + `showBranch` is on.
- **Show Status** prints the last transmitted activity JSON in the plugin log — use that to audit what is public.
