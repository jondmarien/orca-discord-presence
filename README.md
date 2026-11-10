<div align="center">

<img src="assets/orca.png" width="96" alt="Shipped Discord Rich Presence large asset (orca)" />

# Rich Presence for Discord (Orca plugin)

**Workspace, branch, and agent state on your Discord profile. Every identifying field is opt-in.**

[![Version](https://img.shields.io/badge/v1.0.3-blue.svg)](orca-plugin.json)
[![Bun](https://img.shields.io/badge/Bun-1.4+-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`jondmarien.discord-presence` · Orca `>=1.4.248` · not affiliated with Discord

</div>

<img width="1400" height="520" alt="Rich Presence for Discord showing Orca agent state on a Discord profile" src="https://github.com/user-attachments/assets/d8cf8947-c451-4e29-92f7-1a2cd271227d" />

The default Discord text is `Working in Orca`, plus an optional agent state and an elapsed timer. Repo, branch, and machine names stay off until you raise the detail level. You do not need your own Discord application: the plugin ships Application ID `1545653843239374848` (a public snowflake; there is no bot token and no client secret).

Browser Discord has no IPC socket. Presence needs the desktop client (Discord, Vesktop with arRPC, or Vencord with RPC) on the machine where the plugin runs, or on a [companion](#remote-presence-companion) machine.

## Install

Orca `>=1.4.248`. Enable **Settings → Plugins → Plugin system** first.

- From the directory: <https://www.onorca.dev/plugins/jondmarien/orca-discord-presence>
- From Git: `orca plugin install https://github.com/jondmarien/orca-discord-presence.git#<tag>`

Approve the consent dialog. The plugin asks for:

| Capability | Used for |
|---|---|
| `workspace:read` | Workspace name, branch, terminal count |
| `agent:read` | Agent list and `agent.status.changed` |
| `storage:own` | Plugin storage |
| `settings:own` | Your settings |
| `secrets:own` | Bridge token |
| `notifications:show` | Status toasts |

Then run **Rich Presence: Show Status** from the command palette.

### Upgrading from `chron0.discord-presence`

The identity moved from `chron0.discord-presence` to `jondmarien.discord-presence`. Old settings do not carry over, so uninstall the old copy and set your options again under Orca Settings.

### From source

```bash
bun install
bun test
bun run typecheck
bun run build
```

Commit `dist/main.js` when TypeScript sources change, so a Git install works without a local build. `orca plugin validate` checks the manifest.

## Choosing a Discord client

If more than one Discord app is running (for example Vesktop and the Discord desktop app), presence goes to the first one found by default. To pick one, open the panel (Full view) and choose it from the **Discord client** dropdown. It lists every detected client, and the choice is not in Orca Settings because Settings cannot list clients found at runtime. **Auto (first found)** restores the default.

The list refreshes when the plugin starts, on **Reload**, and at most once a minute after that. If your chosen client is not running, presence falls back to the first one found and the panel says so. The connected client also shows in **Show Status** as `client=<id>`. Socket paths never leave the plugin.

## Where it runs

The plugin worker runs on the machine that hosts the workspace. A paired Orca client, and `orca serve`, use the plugins of the Orca they connect to, not the client's own.

| Setup | Plugin worker runs on | Discord must be on | Needs companion |
|---|---|---|---|
| Orca desktop, local workspaces | That desktop | That desktop (local IPC) | No |
| Linux host with Vesktop, controlled from another machine | Linux host | Linux host (local IPC) | No |
| Linux host, Discord on Windows (Windows Orca paired to Linux) | Linux host | Windows | Yes |
| `orca serve` on an SSH server | SSH server | Your desktop | Yes |

Discord's local IPC socket or pipe exists only on the machine where Discord runs. When the worker and Discord are on different machines, run the [companion](#remote-presence-companion) next to Discord and point the worker at it.

## Settings

Settings are in **Orca Settings** under this plugin. Defaults:

| Setting | Default | Notes |
|---|---|---|
| Show Rich Presence (`enabled`) | on | Off clears your activity |
| Detail level (`detailLevel`) | `generic` | `off`, `generic`, `workspace`, `full` |
| Show git branch (`showBranch`) | off | Needs `full` |
| Show agent state (`showAgentState`) | on | |
| Show terminal count (`showTerminals`) | off | |
| Show machine name (`showMachine`) | off | Needs detail above `generic` |
| Machine name (`machineLabel`) | empty | Empty uses the hostname |
| Show elapsed timer (`showElapsed`) | on | |
| Elapsed timer counts (`elapsedMode`) | `session` | `session` counts time in Orca and resets after 30 minutes with no activity; `state` counts time in the current agent state |
| Discord Application ID (`applicationId`) | `1545653843239374848` | Invalid value falls back to the shipped one |
| Use HTTP bridge (`bridgeEnabled`) | off | Companion path |
| Bridge URL (`bridgeUrl`) | empty | `http` or `https` |
| Debug logging (`debugLogging`) | on | Local log only |
| Button URL (`openUrl`) | empty | HTTPS only |
| Show button (`showOpenButton`) | off | Needs a Button URL |
| Button label (`openButtonLabel`) | `Open Orca` | 1 to 32 characters |
| Show agent count (`showAgentCount`) | off | |
| Show status bar item (`showStatusBar`) | on | Orca desktop app only |

The status bar item shows the current state at a glance (`Working`, `Blocked`, `Waiting`, `Done`, or `Discord`). Clicking it shows or hides the Rich Presence panel. It follows the same privacy settings as the Discord card.

Workspace, branch, and machine names, when you enable them, go to Discord's servers and appear on your profile. See [docs/privacy.md](docs/privacy.md).

### Bridge token

The bridge token is not a visible setting. Set it with **Rich Presence: Configure**, passing `bridgeToken` in the command arguments (an empty string clears it). It is stored in Orca secrets. On hosts without an OS keyring (for example Linux without a secret service), Orca reports secrets as unavailable. The plugin then keeps the token in plugin settings and **Show Status** shows a warning.

### Commands

| Command | Effect |
|---|---|
| Rich Presence: Enable/Disable | Master switch |
| Rich Presence: Show Status | Refresh, re-send, and show `enabled`, `connected`, `sink`, `bridge`, `tokenStore`, `detail` |
| Rich Presence: Reload RPC | Close and reconnect Discord IPC, then publish again |
| Rich Presence: Cycle Detail Level | `off`, `generic`, `workspace`, `full` |
| Rich Presence: Toggle Branch | `showBranch` |
| Rich Presence: Toggle Agent State | `showAgentState` |
| Rich Presence: Toggle Terminal Count | `showTerminals` |
| Rich Presence: Toggle Machine Name | `showMachine` |
| Rich Presence: Toggle Elapsed Timer | `showElapsed` |
| Rich Presence: Toggle Bridge | `bridgeEnabled` |
| Rich Presence: Toggle Debug Logging | `debugLogging` |
| Rich Presence: Toggle Open Button | `showOpenButton` |
| Rich Presence: Toggle Agent Count | `showAgentCount` |
| Rich Presence: Clear | Clear activity without disabling. Held until the next agent event, Show Status, Reload RPC, or a settings change |
| Rich Presence: Configure | Arguments: `applicationId`, `openUrl`, `showOpenButton`, `openButtonLabel`, `showAgentCount`, `bridgeToken`. No arguments shows the current public values. Invalid values are rejected |

## What Discord receives

| Field | Example | Gate | Default |
|---|---|---|---|
| Game name | `Orca` | Discord application name | n/a |
| Details | `Working in Orca` | `detailLevel: generic` | on |
| Workspace | `acme-payments` | `detailLevel` of `workspace` or `full` | off |
| Branch | `feat/refund-flow` | `full` and `showBranch` | off |
| Agent state | `working`, `blocked`, `waiting for input`, `idle` | `showAgentState` | on |
| Agent count | `2 agents · working` | `showAgentCount` | off |
| Button | `Open Orca` and your HTTPS URL | `showOpenButton` and `openUrl` | off |
| Terminals | `3 terminals` | `showTerminals` | off |
| Machine | `jon-desktop` | `showMachine` and detail not `generic` | off |
| Elapsed | start timestamp | `showElapsed` | on |
| Assets | large `orca-v2`, small badge (`working`, `completed`, ...) | any activity | n/a |

You cannot see your own Rich Presence buttons on your profile. Check with a second Discord account.

### Presence look

Every activity uses large image `orca-v2` plus one small badge image named after the state:

| State | Asset key | Preview |
|---|---|---|
| any (large) | `orca-v2` | <img src="assets/orca.png" width="64" alt="orca-v2" /> |
| working | `working` | <img src="assets/working.png" width="48" alt="working" /> |
| blocked | `blocked` | <img src="assets/blocked.png" width="48" alt="blocked" /> |
| waiting for input | `waiting` | <img src="assets/waiting.png" width="48" alt="waiting" /> |
| completed | `completed` | <img src="assets/completed.png" width="48" alt="completed" /> |
| idle, unknown | `idle` | <img src="assets/idle.png" width="48" alt="idle" /> |

The Discord application must have these six keys uploaded under Rich Presence > Art Assets. The shipped application already does. If you use your own Application ID, upload `orca-v2` and the five badges from `assets/` under exactly those names, or the images will not show.

Aliases fold into these before anything is sent: `running` and `active` map to working, `error` and `failed` to blocked, `needs_input` to waiting, `complete` and `finished` to done. Unrecognized strings become `idle` and never appear in the payload.

## How it works

1. **Inputs.** `agent.status.changed`, `workspace.changed`, `workspace.removed`, the `agents.list` snapshot taken at start, and a 90 s `workspace.readContext` heartbeat. An agent seen in both `agents.list` and an event counts once. The plugin does not know which window, tab, or file is focused ([#7](https://github.com/jondmarien/orca-discord-presence/issues/7)).
2. **Privacy gate.** [`src/presence/activity.ts`](src/presence/activity.ts) is the only module that chooses identifying strings. Discord, the HTTP bridge, and the companion send what it returns, or clear.
3. **Publish path.** Local IPC first (Unix sockets or Windows pipes, including Vesktop Flatpak). If local IPC is down and the bridge is on, the same activity is posted to the companion. The plugin never writes to both.
4. **Rate.** At most one `SET_ACTIVITY` per 15 s. The heartbeat and **Show Status** re-send an unchanged payload. Stop and deactivate clear first.

Wire format, debounce, and module map: [docs/architecture.md](docs/architecture.md).

## Remote presence (companion)

The companion is a small HTTP-to-Discord-IPC process. Run it on the machine that has Discord. The plugin worker, wherever it runs, posts activity to it when local Discord is not reachable.

Typical case: Orca on Linux, Windows Orca paired to it, Discord on Windows. The worker runs on Linux, so it posts to a companion on Windows.

### 1. Run the companion (machine with Discord)

The companion runs from source. From the repository root, with Bun 1.4+:

```bash
bun install
bun run companion
```

Default bind is `127.0.0.1:3848`. For Tailscale or LAN, bind wider and set a token:

```bash
export ORCA_PRESENCE_BIND=0.0.0.0
export ORCA_PRESENCE_PORT=3848
export ORCA_PRESENCE_BRIDGE_TOKEN='<high-entropy secret>'   # openssl rand -hex 32
bun run companion
```

PowerShell uses `$env:ORCA_PRESENCE_BIND = "0.0.0.0"` with the same names. Building a standalone binary (`bun run companion:compile`) is optional and local only. Never commit the binary.

| Env | Default | Notes |
|---|---|---|
| `ORCA_PRESENCE_BIND` | `127.0.0.1` | `0.0.0.0` or the machine's Tailscale IP |
| `ORCA_PRESENCE_PORT` | `3848` | |
| `ORCA_PRESENCE_BRIDGE_TOKEN` | empty | Required off loopback; the companion refuses to start without it |
| `ORCA_PRESENCE_CLIENT_ID` | shipped Application ID | Same public snowflake as the plugin |

### 2. Reach it from the worker

- **Tailscale (recommended):** both machines on one tailnet, bind to the Tailscale IP or `0.0.0.0`, use a token, set Bridge URL to `http://<tailscale-ip>:3848`.
- **SSH tunnel:** keep the companion on loopback and forward from the worker's machine: `ssh -N -L 3848:127.0.0.1:3848 user@companion-host`. Then Bridge URL is `http://127.0.0.1:3848` and a token is optional.

### 3. Configure the plugin (on the machine running the worker)

1. In Orca Settings, turn on **Use HTTP bridge** and set **Bridge URL**.
2. Run **Rich Presence: Configure** with `bridgeToken` set to the same value as `ORCA_PRESENCE_BRIDGE_TOKEN`.
3. Run **Rich Presence: Show Status**. With no local Discord on the worker's machine it reports `connected=false sink=bridge`.

Worker-side env overrides: `ORCA_PRESENCE_BRIDGE_ENABLED`, `ORCA_PRESENCE_BRIDGE_URL`, `ORCA_PRESENCE_BRIDGE_TOKEN`.

The token is a shared secret between worker and companion. It is not sent to Discord and not printed by Show Status or logs. Turn the bridge off when unused.

| Method | Path | Effect |
|---|---|---|
| `POST` | `/activity` | `SET_ACTIVITY` on the companion's Discord client |
| `DELETE` | `/activity` | Clear |
| `GET` | `/health` | `{ ok, discordConnected }` (no token required) |

Authenticated requests send `Authorization: Bearer <token>`. More in [companion/README.md](companion/README.md).

## Diagnostics

### Panel

The **Rich Presence** panel (`presence`, `panel/index.html`) shows live status, a redacted settings summary, and recent log lines. It talks to the worker through `window.orca.plugin.request` and receives updates through `orca.panels.post`. Outside the Orca desktop app (for example in a browser client) it shows a static note: "Open this panel in the Orca desktop app to see live status."

The panel never receives the Application ID, bridge URL, bridge token, or button URL.

### Log file

The same structured lines that go to `orca.log` also go to a capped file. `error` and `warn` always log. `info` and `debug` log when `debugLogging` is on.

| OS | Default path |
|---|---|
| Linux, macOS | `$XDG_STATE_HOME/jondmarien-discord-presence/plugin.log`, else `~/.local/state/jondmarien-discord-presence/plugin.log` |
| Windows | `%LOCALAPPDATA%\jondmarien-discord-presence\plugin.log` |

Override with `ORCA_PRESENCE_LOG_FILE`. The file rotates to `plugin.log.1` at 256 KiB. `connected=true` means local IPC succeeded. `sink=bridge` means the companion published.

Set `ORCA_PRESENCE_DISCORD_IPC` to force a specific Discord IPC socket or pipe path.

## Not supported

| Limit | Instead |
|---|---|
| Focused window, tab, or file | Presence is workspace and agent status. Tracked in [#7](https://github.com/jondmarien/orca-discord-presence/issues/7) |
| Presence from a remote worker without a companion | Run the [companion](#remote-presence-companion) where Discord runs |
| Browser Discord | Use the desktop client, Vesktop, or Vencord with RPC |
| Installing the plugin on two machines as a bridge | Companion on the Discord machine, plugin on the worker's machine |
| Machine name of an SSH remote | `os.hostname()` is the machine running the worker. Leave **Show machine name** off or set **Machine name** |
| Instant branch updates | Branch switches emit no event. Wait up to 90 s, or run Show Status |

Roadmap and host API work: [ROADMAP.md](ROADMAP.md).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No presence | Browser Discord only | Run the desktop client, signed in |
| Desktop running, nothing shows | Activity Privacy off | Discord Settings, Activity Privacy, enable the current-activity status |
| `connected=false` | Client not ready or socket missing | Start Discord, then **Reload RPC** (3 tries, 3 s to 15 s backoff) |
| Another game wins | Competing RPC client | **Reload RPC**, or wait for the 90 s re-send |
| "Playing Orca" after quit | Ghost activity | **Reload RPC**, or toggle Enable/Disable once |
| Linux cannot find the socket | `XDG_RUNTIME_DIR` stripped from the worker env | The plugin tries `/run/user/<uid>` and Flatpak/Snap paths. Or set `ORCA_PRESENCE_DISCORD_IPC` |
| Vesktop Flatpak, no presence | Socket inside the sandbox | Enable Rich Presence via arRPC. The plugin probes `.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-*` |
| Agents on one machine, Discord on another | Local IPC cannot cross machines | [Companion](#remote-presence-companion) |
| Show Status warns `secrets unavailable` | No OS keyring | The token is kept in plugin settings. Install a keyring (for example a secret service) to move it to secrets |
| Panel shows "Open this panel in the Orca desktop app" | Panel opened outside the desktop app | Use the Orca desktop app |
| Lags during agent activity | Discord rate limit | Expected: at most one update per 15 s |
| Panel shows "Connected · updates failing" | Discord accepted the connection but does not answer updates | Fully quit Discord from the tray and restart it. To check each IPC pipe, run `bun scripts/discord-probe.mjs` from a clone of this repo |

## Docs

| Doc | What |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Process model, IPC, debounce, panel |
| [docs/privacy.md](docs/privacy.md) | Gate table and never-transmitted list |
| [companion/README.md](companion/README.md) | Companion start and HTTP surface |
| [ROADMAP.md](ROADMAP.md) | Limits and follow-up work |
| [Issues](https://github.com/jondmarien/orca-discord-presence/issues) | Tracker |

## License

MIT
