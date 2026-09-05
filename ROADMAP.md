# Roadmap

Author: Jonathan Marien  
Date: 2026-09-05

Known limits of `chron0.discord-presence` and the Orca host work that would unlock richer presence. This is not a schedule.

Presence today is **local Discord IPC first**. The Vesktop Flatpak path in `src/discord/ipc.ts` only finds a socket on the same machine as the plugin worker. An **opt-in HTTP companion** (Linux, macOS, or Windows) can publish that same privacy-gated activity on another machine ([#6](https://github.com/jondmarien/orca-discord-presence/pull/6) plugin MVP). A native Orca remote-presence API is still future work — [#10](https://github.com/jondmarien/orca-discord-presence/issues/10).

See also [README](README.md), [Architecture](docs/architecture.md), [Privacy](docs/privacy.md). Host/API follow-up: [#10](https://github.com/jondmarien/orca-discord-presence/issues/10). Companion MVP: [#6](https://github.com/jondmarien/orca-discord-presence/pull/6).

---

## Local IPC (still the primary path)

The plugin worker talks to Discord / Vesktop over a Unix socket or Windows named pipe on **this** machine when one accepts a handshake. Browser Discord has no IPC.

For **local** presence:

1. The plugin must run in the Orca **host / runtime** process (Linux, macOS, or Windows — the machine that forks the trusted Node worker).
2. Discord desktop or Vesktop (with arRPC if Flatpak) must be installed, **running**, and **signed in** on that same host.
3. The worker must be able to open `discord-ipc-*` (unsandboxed, official Flatpak/Snap, or Vesktop Flatpak — see README troubleshooting).

If **Show Status** reports `enabled=true connected=true`, this path is working. Closing or signing out of Vesktop/Discord on the host stops the local path; the plugin retries on the next update or 90 s heartbeat, and will use the companion if the bridge is enabled.

---

## Cross-machine case — plugin MVP (done)

User-confirmed split (originally [#3](https://github.com/jondmarien/orca-discord-presence/issues/3); companion shipped in [#6](https://github.com/jondmarien/orca-discord-presence/pull/6)) — one configuration among several:

| Machine | Role | Discord / Vesktop |
|---|---|---|
| **Omarchy (Arch)** | Orca host running the project and agents | Often none |
| **Windows** | UI / remote to Omarchy; Discord + Vencord signed in | Yes |

The same design applies to any pair: host on Linux/macOS/Windows, companion on Linux/macOS/Windows.

**Why local IPC alone fails.** Presence IPC is local to Discord on that OS.

- The host has the agent truth but **no** Discord socket.
- The Discord machine has a client, but installing this plugin there does not see remote-host agent events. Dual plugin install is not a bridge.

**What shipped (plugin-only, no Orca core changes):**

- OS-agnostic **companion** under `companion/` — same Discord IPC client as the plugin (win32 pipes + POSIX sockets, including Vesktop Flatpak). HTTP `POST /activity` + `DELETE /activity`.
- Opt-in plugin settings `bridgeEnabled` / `bridgeUrl` / `bridgeToken` (default **off**).
- Publish policy: **prefer local IPC if connected, else bridge**. No dual-publish. Disable/stop clears remote activity.
- Token required for non-loopback bind/URL. Tailscale and SSH-tunnel documented in the README.

**Still future (Orca-native):** a host-mediated remote capability so this does not require a sidecar process or operator-set URL/token. Tracked in [#10](https://github.com/jondmarien/orca-discord-presence/issues/10) (fork-first, then upstream).

---

## Remote UI and smoke tests

Controlling Orca from another machine does **not** require installing this plugin on the UI machine. Presence still depends on either Vesktop/Discord **on the host**, or the companion on the machine that has Discord.

| Machine | Needs this plugin? | Needs Discord / Vesktop? | Needs companion? |
|---|---|---|---|
| Orca **host / runtime** | Yes — the worker runs here | Yes for local IPC; no if using the bridge | No |
| Other OS with Discord (publisher) | No | Yes | Yes, when the host has no Discord |
| Other OS viewing profile only | No | No | No |

**Smoke test (local IPC):** Orca host + Vesktop/Discord signed in on **that same host**. **Show Status** → `connected=true` (example: `enabled=true connected=true detail=generic`). Presence is visible on the Discord account from every client — Discord’s servers fan it out.

**Smoke test (companion MVP):** Host plugin + `bridgeEnabled` / URL / token; companion on the Discord machine (Tailscale, LAN, or SSH tunnel); Discord/Vesktop/Vencord signed in there. **Show Status** on the host → `connected=false sink=bridge` when the host has no local Discord.

---

## What we do not detect

No focused Orca window/tab (terminal vs agent UI). Inputs are `agent.status.changed` + `workspace.readContext` only. Subscribe to host focus/tab events **if Orca adds them** — do not invent. See [#7](https://github.com/jondmarien/orca-discord-presence/issues/7).

---

## Follow-up checklist ([#10](https://github.com/jondmarien/orca-discord-presence/issues/10))

- [x] Document the dual-host gap in README + ROADMAP
- [x] Optional OS-agnostic companion + plugin HTTP bridge (privacy-first, default off)
- [ ] Full Orca-native remote capability / host-mediated presence (upstream Orca)
- [ ] Richer host capability APIs (projections for where the worker runs, which machine owns Discord, optional off-box sink) — Track B in `PLAN.md`
- [ ] Active-tab / focus events if the host ever exposes them (activity expiry helper is already in `src/presence/expiry.ts`; do not invent a second window)
- [ ] Provider priority + rotation once multiple surfaces exist (#7 / #8 deferred)
- [ ] Feature additions that still need host APIs — file-level presence; settings panel; user-facing Application ID override; SSH/runtime host labels instead of `os.hostname()`

None of the remaining items is required for the companion MVP.
