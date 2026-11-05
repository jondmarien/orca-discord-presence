# Orca Discord presence companion

Author: Jonathan Marien  
Date: 2026-11-04

Small Bun/Node ESM service for the machine that has Discord, Vesktop, or Vencord (Linux, macOS, or Windows). It applies `SET_ACTIVITY` through the same IPC client as the plugin (`src/discord/client.ts`: Windows named pipes and POSIX sockets, including Vesktop Flatpak). Handshake-not-ready and handshake timeouts retry with 3 tries and 3 s to 15 s backoff. A missing local socket fails immediately.

Paired Orca clients and `orca serve` run plugins on the host, not on the client. When Discord is on a different machine than the plugin worker, the worker posts activity here. Typical case: Orca on Linux, Discord on Windows.

The companion runs from source. Building a binary is optional and local only; do not commit it.

Full setup, Tailscale, SSH tunnel, and the token: [../README.md](../README.md#remote-presence-companion).

```bash
# from the repository root (Linux, macOS, Windows)
bun install
bun run companion

# Tailscale / LAN (token required)
export ORCA_PRESENCE_BIND=0.0.0.0
export ORCA_PRESENCE_BRIDGE_TOKEN='<secret>'
bun run companion

# optional, local only
bun run companion:compile
```

You can also run `bun run start` from this directory.

On the machine running the plugin worker, set the same token with **Rich Presence: Configure** (`bridgeToken` argument) and turn on **Use HTTP bridge** with the Bridge URL in Orca Settings.

| Method | Path | Effect |
|---|---|---|
| `POST` | `/activity` | Set activity (JSON body) |
| `DELETE` | `/activity` | Clear |
| `GET` | `/health` | `{ ok, discordConnected }` |

Default bind: `127.0.0.1:3848`. A non-loopback bind requires `ORCA_PRESENCE_BRIDGE_TOKEN`.
