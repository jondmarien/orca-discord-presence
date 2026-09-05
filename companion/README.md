# Orca Discord presence companion

Author: Jonathan Marien  
Date: 2026-09-05

Small Bun/Node ESM service for **whichever machine has Discord / Vesktop / Vencord** (Linux, macOS, or Windows). It applies `SET_ACTIVITY` using the **same** IPC client as the plugin (`src/discord/client.ts` — win32 named pipes and POSIX sockets, including Vesktop Flatpak). Handshake-not-ready and handshake timeouts retry with the same 3× / 3s→15s backoff; a missing local socket still fails immediately.

The Orca **host/runtime** (any OS) optionally POSTs activity here when local Discord IPC on that host is unavailable. Not a Windows-only sidecar.

Full setup, Tailscale, SSH tunnel, and security notes: [../README.md](../README.md#cross-machine-companion-linux--macos--windows).

```bash
# from this directory (Linux, macOS, Windows)
bun run start

# Tailscale / LAN (token required)
export ORCA_PRESENCE_BIND=0.0.0.0
export ORCA_PRESENCE_BRIDGE_TOKEN='<secret>'
bun run start

# optional standalone binary
bun run compile
```

| Method | Path | Effect |
|---|---|---|
| `POST` | `/activity` | Set activity (JSON body) |
| `DELETE` | `/activity` | Clear |
| `GET` | `/health` | `{ ok, discordConnected }` |

Default bind: `127.0.0.1:3848`. Plugin id remains `chron0.discord-presence`.
