# Roadmap

Author: Jonathan Marien  
Date: 2026-09-05

Known limits of `chron0.discord-presence` and the Orca host work that would unlock richer presence. This is not a schedule.

Presence today is **local Discord IPC first**. The Vesktop Flatpak path in `src/discord/ipc.ts` only finds a socket on the same machine as the plugin worker. An **opt-in HTTP companion** can publish that same privacy-gated activity on another OS (issue [#3](https://github.com/jondmarien/orca-discord-presence/issues/3) plugin MVP). A native Orca remote-presence API is still future work.

See also [README](README.md), [Architecture](docs/architecture.md), [Privacy](docs/privacy.md). Tracked in [#3](https://github.com/jondmarien/orca-discord-presence/issues/3).

---

## Local IPC (still the primary path)

The plugin worker talks to Discord / Vesktop over a Unix socket or Windows named pipe on **this** machine when one accepts a handshake. Browser Discord has no IPC.

For **local** presence:

1. The plugin must run in the Orca **host / runtime** process (the machine that forks the trusted Node worker).
2. Discord desktop or Vesktop (with arRPC if Flatpak) must be installed, **running**, and **signed in** on that same host.
3. The worker must be able to open `discord-ipc-*` (unsandboxed, official Flatpak/Snap, or Vesktop Flatpak — see README troubleshooting).

Closing or signing out of Vesktop/Discord on the host stops the local path; the plugin retries on the next update or 90 s heartbeat, and will use the companion if the bridge is enabled.

---

## Dual-host case — plugin MVP (done)

User-confirmed split ([#3](https://github.com/jondmarien/orca-discord-presence/issues/3)):

| Machine | Role | Discord / Vesktop |
|---|---|---|
| **Omarchy** | Orca host running the project and agents | Often none |
| **Windows** | Full Orca install used as the UI, also talking to Omarchy projects | Discord + Vencord, local and signed in |

**Why local IPC alone fails.** Presence IPC is local to Discord on that OS.

- Omarchy has the agent truth but **no** Discord socket.
- Windows has Discord, but installing this plugin there does not see Omarchy agent events. Dual plugin install is not a bridge.

**What shipped (plugin-only, no Orca core changes):**

- Windows (or any OS) **companion** under `companion/` — same Discord IPC client as the plugin, HTTP `POST /activity` + `DELETE /activity`.
- Opt-in plugin settings `bridgeEnabled` / `bridgeUrl` / `bridgeToken` (default **off**).
- Publish policy: **prefer local IPC if connected, else bridge**. No dual-publish. Disable/stop clears remote activity.
- Token required for non-loopback bind/URL. Tailscale documented in the README.

**Still future (Orca-native):** a host-mediated remote capability so this does not require a sidecar process, marketplace-free companion, or operator-set URL/token. That remains an upstream Orca PR candidate.

---

## Remote UI and the valid smoke test

Controlling Orca from another machine does **not** require installing this plugin on the UI machine. Presence still depends on either Vesktop/Discord **on the host**, or the companion on the machine that has Discord.

| Machine | Needs this plugin? | Needs Discord / Vesktop? | Needs companion? |
|---|---|---|---|
| Orca **host** (Omarchy) | Yes — the worker runs here | Yes for local IPC; no if using the bridge | No |
| Orca **UI** (Windows) with Discord | No | Yes, if that box should publish | Yes, when the host has no Discord |
| Orca **UI** (Windows) viewing profile only | No | No | No |

**Smoke test (local IPC):** run the Orca host + Vesktop (signed in, arRPC enabled) on Omarchy with this plugin. Confirm Rich Presence on the Discord user account. You can *see* that activity from Windows Discord / Vencord as profile status even though Windows Discord is **not** the IPC publisher — Discord’s servers fan the host-published activity out to every client.

**Smoke test (companion MVP):** Omarchy host with the plugin + `bridgeEnabled` / URL / token; Windows companion listening (Tailscale or LAN bind + token); Discord/Vencord signed in on Windows. Confirm `sink=bridge` from **Show Status** on the host and Rich Presence on the account.

---

## Issue #3 checklist

- [x] Document the dual-host gap in README + ROADMAP
- [x] Optional Windows companion + plugin HTTP bridge (privacy-first, default off)
- [ ] Full Orca-native remote capability / host-mediated presence (upstream Orca)
- [ ] Richer host capability APIs (projections for where the worker runs, which machine owns Discord, optional off-box sink) — Track B in `PLAN.md`
- [ ] Feature additions that still need host APIs — file-level presence; settings panel; user-facing Application ID override; SSH/runtime host labels instead of `os.hostname()`

None of the remaining items is required for the companion MVP.
