# Orca Discord presence companion

Author: Jonathan Marien  
Date: 2026-09-05

Small Bun/Node ESM service for the machine that has Discord / Vencord (typically Windows). It applies `SET_ACTIVITY` using the **same** IPC client as the plugin (`src/discord/client.ts`).

Full setup, Tailscale, and security notes: [../README.md](../README.md#omarchy-host--windows-discord-companion).

```powershell
# from this directory
bun run start

# Tailscale / LAN (token required)
$env:ORCA_PRESENCE_BIND = "0.0.0.0"
$env:ORCA_PRESENCE_BRIDGE_TOKEN = "<secret>"
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
