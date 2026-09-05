# Roadmap

Author: Jonathan Marien  
Date: 2026-09-05

Known limits of `chron0.discord-presence` and the Orca host work that would unlock richer presence. This is not a schedule.

Presence today is **local Discord IPC only**. The Vesktop Flatpak path in `src/discord/ipc.ts` does not change that: it only finds the socket on the same machine as the plugin worker.

See also [README](README.md), [Architecture](docs/architecture.md), [Privacy](docs/privacy.md). Tracked in [#3](https://github.com/jondmarien/orca-discord-presence/issues/3).

---

## Local IPC only

The plugin worker talks to Discord / Vesktop over a Unix socket or Windows named pipe on **this** machine. Browser Discord has no IPC.

For presence to show:

1. The plugin must run in the Orca **host / runtime** process (the machine that forks the trusted Node worker).
2. Discord desktop or Vesktop (with arRPC if Flatpak) must be installed, **running**, and **signed in** on that same host.
3. The worker must be able to open `discord-ipc-*` (unsandboxed, official Flatpak/Snap, or Vesktop Flatpak — see README troubleshooting).

There is no HTTP client, no Discord bot, and no remote RPC. Closing or signing out of Vesktop/Discord on the host stops presence until the client is back; the plugin retries on the next update or 90 s heartbeat.

---

## Dual-host case that does not work (confirmed)

User-confirmed split ([#3](https://github.com/jondmarien/orca-discord-presence/issues/3)):

| Machine | Role | Discord / Vesktop |
|---|---|---|
| **Omarchy** | Orca host running the project and agents | None |
| **Windows** | Full Orca install used as the UI, also talking to Omarchy projects | Discord + Vencord, local and signed in |

**Why it fails.** Presence IPC is local to Discord on that OS.

- Omarchy has the agent truth but **no** Discord socket.
- Windows has Discord, but the plugin only sees whatever **local** Orca host process loads it. Remote Omarchy agent events are **not** bridged to a Windows-local plugin for `SET_ACTIVITY`.

Installing the plugin on **both** machines does **not** create a bridge. A Windows-only install also does not help unless that Windows box is the Orca host for those agents *and* has Discord/Vesktop.

**What would be needed.** An Orca-level (or companion) cross-machine presence bridge / remote capability so host-side activity can drive Discord IPC on another machine. That is an upstream Orca PR candidate, not something this plugin can do alone with local IPC.

---

## Remote UI and the valid smoke test

Controlling Orca from another machine does **not** require installing this plugin on the UI machine. Presence still depends on Vesktop or Discord **on the host**.

| Machine | Needs this plugin? | Needs Discord / Vesktop? |
|---|---|---|
| Orca **host** (Omarchy) | Yes — the worker runs here | Yes — signed-in desktop client / Vesktop + arRPC |
| Orca **UI** (Windows) | No | No, unless that box is also a host that should publish |

**Smoke test that works today:** run the Orca host + Vesktop (signed in, arRPC enabled) on Omarchy with this plugin. Confirm Rich Presence on the Discord user account. You can *see* that activity from Windows Discord / Vencord as profile status even though Windows Discord is **not** the IPC publisher — Discord’s servers fan the host-published activity out to every client.

If Vesktop/Discord on the host is closed or signed out, there is **no** presence. Two UI-only installs cannot reach the host socket.

---

## Future / Orca PR topics

Plugin-only work cannot invent a socket on a different machine. These belong as additive Orca (or companion) changes — see [#3](https://github.com/jondmarien/orca-discord-presence/issues/3):

- **Cross-machine presence bridge** — host-mediated path so a signed-in Discord/Vesktop on a *different* machine can publish Omarchy (or other remote-host) activity. Required for the dual-host case above.
- **Optional Windows-side companion** — a small host-local helper on a Windows Orca host (named pipe `\\?\pipe\discord-ipc-N`) when that box, not Omarchy, is the runtime.
- **Richer host capability APIs** — projections and capabilities that make remote Discord / multi-host presence possible without dual installs (where the worker runs, which machine owns Discord, optional off-box presence sink). Track B in `PLAN.md` (agent type/model, execution host, terminal shell, panel-callable settings) is the same class of additive `pluginApi` work.
- **Feature additions that serve this plugin’s ideas** — file-level or buffer presence if the host ever exposes it; settings panel (today each toggle is a command); user-facing Application ID override; SSH/runtime host labels instead of `os.hostname()`.

None of the above is required for the current local-IPC MVP, including Vesktop Flatpak discovery.
