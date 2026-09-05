# Privacy

Author: Jonathan Marien  
Date: 2026-09-05

`chron0.discord-presence` is privacy-first by default. This note is the disclosure contract: what can leave the machine, what never does, and which setting unlocks each field.

The **only** module that chooses identifying strings is [`src/presence/activity.ts`](../src/presence/activity.ts). The Discord client, HTTP bridge, and companion transmit whatever that builder returns (or clear when it returns `null`). Downstream code does not re-check gates. The companion is not a second privacy filter.

## Defaults

From `DEFAULT_SETTINGS` in [`src/presence/settings.ts`](../src/presence/settings.ts):

- Presence **enabled**, detail **`generic`**.
- Branch, machine, and terminal count **off**.
- Agent state and elapsed timer **on**.
- Application id is the shipped public snowflake `1545653843239374848`.
- Companion bridge **off** (`bridgeEnabled: false`, empty URL/token).
- `debugLogging` **on** (local `orca.log` + state-dir file; not sent to Discord).

`generic` never includes a workspace display name, git branch, or machine name — even if `showBranch` or `showMachine` were flipped on. Those toggles only take effect at higher detail levels (machine also requires detail ≠ `generic`; branch requires `full`).

## What Discord receives

When an activity is produced, Discord’s servers render it on your profile. That path is:

1. Plugin worker → local Discord desktop IPC socket (`SET_ACTIVITY`), **or** (only if you enable the bridge and local IPC is down) plugin worker → `POST /activity` on the companion you configured → that machine’s Discord IPC.
2. Discord desktop → Discord’s presence service.

There is no analytics host and no Discord bot. The HTTP client exists **only** for the opt-in companion. Browser Discord is not used and cannot receive these writes (no IPC).

The bridge token is a shared secret between the Orca host and the companion. It is stored in `settings:own` (or env) and sent as `Authorization: Bearer`. It is never sent to Discord and is never printed by **Show Status**.

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
| The bridge bearer token (not part of the activity JSON) |

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
- `bridgeUrl` must be `http:` / `https:` with no URL credentials; trailing `/activity` is stripped. Otherwise it becomes `""`.
- `bridgeToken` is trimmed and capped at 256 characters.
- A non-loopback `bridgeUrl` without a token is not used (`resolveBridgeTarget` returns `null`).

Commands persist the full normalized object via `settings.set` (one key per field). There is no settings panel in v0.3.

## Capabilities

The consent dialog lists `workspace:read`, `events:subscribe`, `storage`, `settings:own`, and `notifications:show`. There is no `secrets` capability.

## Operator advice

- Leave detail at `generic` on shared or client-named workspaces unless you intend to publish the name.
- Treat repository / branch names as client-identifying once `full` + `showBranch` is on.
- **Show Status** prints the last transmitted activity JSON in the plugin log and the on-disk file — use that to audit what is public.
- Leave `bridgeEnabled` off unless you intend to send that same JSON to a companion you control (any OS). Prefer Tailscale or an SSH tunnel over a raw LAN bind.
- The debug file is local-only. Turn `debugLogging` off if you do not want activity JSON on disk. The bridge token is never written.
