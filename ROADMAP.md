# Roadmap

Author: Jonathan Marien  
Date: 2026-09-05

Known limits of `chron0.discord-presence` and the Orca host work that would unlock richer presence. This is not a schedule.

Presence today is **local Discord IPC only**. The Vesktop Flatpak path in `src/discord/ipc.ts` does not change that: it only finds the socket on the same machine as the plugin worker.

See also [README](README.md), [Architecture](docs/architecture.md), [Privacy](docs/privacy.md).

---

## Local IPC only

The plugin worker talks to Discord / Vesktop over a Unix socket or Windows named pipe on **this** machine. Browser Discord has no IPC.

For presence to show:

1. The plugin must run in the Orca **host / runtime** process (the machine that forks the trusted Node worker).
2. Discord desktop or Vesktop (with arRPC if Flatpak) must be installed, **running**, and **signed in** on that same host.
3. The worker must be able to open `discord-ipc-*` (unsandboxed, official Flatpak/Snap, or Vesktop Flatpak — see README troubleshooting).

There is no HTTP client, no Discord bot, and no remote RPC. Closing or signing out of Vesktop/Discord on the host stops presence until the client is back; the plugin retries on the next update or 90 s heartbeat.

---

## Remote UI (Windows → Omarchy host)

Controlling Orca from another machine does **not** require installing this plugin on the UI machine.

Example: Windows UI talking to an Omarchy (or other Linux) host.

| Machine | Needs this plugin? | Needs Discord / Vesktop? |
|---|---|---|
| Orca **host** (Omarchy) | Yes — the worker runs here | Yes — signed-in desktop client / Vesktop + arRPC |
| Orca **UI** (Windows) | No | No (unless that box is also a host) |

Presence still depends on Vesktop or Discord **on the host**. The Windows UI only drives the session; it does not own the IPC socket.

---

## Signed-out or closed Vesktop on the host

If Vesktop/Discord on the host is closed or signed out, there is **no** presence.

Installing the plugin on the Windows UI box does **not** help, unless that Windows box is itself an Orca **host** with its own signed-in Discord/Vesktop. Two UI-only installs cannot reach the host socket.

---

## Future / Orca PR topics

Plugin-only work cannot invent a socket on a different machine. These belong as additive Orca (or companion) changes:

- **Cross-machine presence bridge** — host-mediated path so a signed-in Discord/Vesktop on a *different* machine can publish the same activity, without copying the plugin to every UI.
- **Optional Windows-side companion** — a small host-local helper on a Windows Orca host (named pipe `\\?\pipe\discord-ipc-N`) when that box, not Omarchy, is the runtime.
- **Richer host capability APIs** — projections and capabilities that make remote Discord / multi-host presence possible without dual installs (where the worker runs, which machine owns Discord, optional off-box presence sink). Track B in `PLAN.md` (agent type/model, execution host, terminal shell, panel-callable settings) is the same class of additive `pluginApi` work.
- **Feature additions that serve this plugin’s ideas** — file-level or buffer presence if the host ever exposes it; settings panel (today each toggle is a command); user-facing Application ID override; SSH/runtime host labels instead of `os.hostname()`.

None of the above is required for the current local-IPC MVP, including Vesktop Flatpak discovery.
