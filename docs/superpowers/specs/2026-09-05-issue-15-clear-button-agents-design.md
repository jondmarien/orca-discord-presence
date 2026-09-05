# Issue #15 — Clear, presence button, configure, multi-agent

Author: Jonathan Marien  
Date: 2026-09-05

Design for [issue #15](https://github.com/jondmarien/orca-discord-presence/issues/15): nacho-parity product gaps that Orca `pluginApi` 1 already supports. Not a port of `nacho.orca-discord-presence`. Panel form UI stays on [#10](https://github.com/jondmarien/orca-discord-presence/issues/10).

This spec is the approved scope from the issue + implement-as-PR brief (Cloud Agent; no interactive review loop).

## Problem

`chron0.discord-presence` v0.4.1 keeps a single agent snapshot, has no Clear command, no opt-in Discord activity button, no command-first Application ID / URL configure path, a thin state alias table, and no pane/worktree retention. Those gaps are all doable on today’s host.

## Constraints

- Plugin id stays `chron0.discord-presence`. File-level `@author Jonathan Marien` only.
- Privacy: `detailLevel: generic` remains the default. Project / branch stay gated.
- Never put secrets in `openUrl`. HTTPS only. No credentials-in-URL.
- Keep existing `state-*` assets only (`state-working`, `state-blocked`, `state-waiting`, `state-idle`).
- Tests must not require a live Discord client.
- Version bump to **0.5.0** (user-visible feature set).
- Context7 MCP quota was exceeded during research. Discord button schema is confirmed from official docs (see Discord buttons).

## Approaches considered

1. **Layered modules on the current controller** (recommended). Keep `buildActivity` as the privacy boundary. Add an in-memory agent table + configure helper + Clear hold flag. Recreate the Discord client only when Application ID changes. Lowest risk; matches existing debounce / local-then-bridge publish.
2. **Replace the controller with an event-sourced store.** One table for workspace + agents + settings. Cleaner long-term, but rewrites a well-tested debounce/bridge path for no #15 gain.
3. **Thin nacho-style port.** Copy their settings names and payload shape. Rejected: different plugin id, different privacy defaults, and the issue says not a port.

Recommendation: **(1)**.

## Discord buttons (official schema)

Context7 (`resolve-library-id` / `query-docs` for discord-api-docs and discord-rpc) returned **monthly quota exceeded**. Schema is taken from official Discord docs, not invented:

- Activity object `buttons?`: array of buttons, **max 2**.
- [Gateway Activity Buttons](https://docs.discord.com/developers/events/gateway-events): when **sending**, each button is `{ label, url }` (gateway **receive** shape is label strings only; bots cannot read URLs).
- Label **1–32** characters; URL **1–512** characters.
- [Setting Rich Presence](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence): you cannot see buttons on your own Rich Presence; test with a second account.
- This plugin attaches **at most one** button. Prefer **HTTPS**. Reject `http:`, `javascript:`, `data:`, and URLs with userinfo.

`SET_ACTIVITY` already forwards the activity object as JSON (`src/discord/client.ts`). Adding `buttons` is enough; the companion publishes the same object.

## Design

### 1. Clear (`presence.clear`)

**Discord Presence: Clear** sends `SET_ACTIVITY` null on local IPC and `DELETE /activity` on the companion when that was the last sink. It does **not** flip `enabled` or `detailLevel`.

**Hold behavior (documented):** after Clear, automatic republish is held. Heartbeat and identical workspace refreshes do **not** bring presence back. The next `agent.status.changed`, or a user command that means “show presence again” (Show Status, Reload RPC, configure, any toggle / persist), lifts the hold and may `SET_ACTIVITY` again.

This is a transient clear, not a disable.

### 2. Optional presence button

New settings (all opt-in):

| Key | Default | Meaning |
|---|---|---|
| `openUrl` | `""` | HTTPS URL, 1–512 chars after trim. Empty = no button. |
| `showOpenButton` | `false` | Master flag for the button. |
| `openButtonLabel` | `Open Orca` | Discord label, clamped to 1–32. Empty normalizes to the default. |

`buildActivity` attaches `buttons: [{ label, url }]` only when `showOpenButton` is true **and** `openUrl` is a normalized HTTPS URL. Otherwise the field is omitted. Not gated by detail level (the operator chose the URL). Panel snapshot never includes `openUrl` (same hygiene as `bridgeUrl`).

### 3. Configure (command-first)

Widen `OrcaHost.commands.register` to `handler: (args?: Record<string, unknown>) => Promise<unknown>` so host `invokeCommand` args type-check.

**`presence.configure`** applies a partial patch:

- `applicationId`: omitted = no change; `""` / whitespace = persist shipped snowflake; valid 17–20 digit snowflake = persist; anything else = **fail-fast** (do not persist, toast + return `{ ok: false, error }`).
- `openUrl`, `showOpenButton`, `openButtonLabel`, `showAgentCount`: same fail-fast for wrong types / invalid URL.

Palette invoke with no args (or `{}`) does not persist. It toasts / returns the current public configure view plus a usage hint.

Changing `applicationId` **recreates** the Discord IPC client (handshake `client_id` is fixed at `createDiscordClient`). Then refresh.

Also add palette toggles (no args) so operators without `invokeCommand` can flip the new booleans:

- `presence.toggle-open-button` → `showOpenButton`
- `presence.toggle-agent-count` → `showAgentCount`

Activate still falls back + toasts on a persisted junk Application ID (existing). Configure is the strict path.

### 4. Multi-agent summary

Parse the full `agent.status.changed` payload: `worktreeId`, `paneKey`, `state`, `receivedAt`. Missing ids become `""` so a single anonymous slot still works.

Key: `worktreeId + U+001F + paneKey`.

In-memory table in `src/presence/agents.ts`. Aggregate priority (highest wins): **blocked > waiting > working > done**. Elapsed start = earliest `receivedAt` among slots that share the winning canonical state.

When `showAgentCount` is on and `agentCount > 0`, the state line includes `N agent(s)` (example: `2 agents · working`). Still privacy-gated by existing toggles / detail level.

`worktree.removed`: if a `worktreeId` (or `id`) is present, drop matching slots, then refresh.

### 5. Retention

Extend `src/presence/expiry.ts`:

- Non-done slots: drop after **30 minutes** from `receivedAt`.
- `done` slots: drop after **60 seconds** from `receivedAt`.
- Reuse `isActivityFresh`. Existing `ACTIVITY_EXPIRY_MS` (30s / 60s) stays for future focus providers (#7).

A timer fires at the next expiry. Prune → if the table changed, refresh presence.

Heartbeat also prunes before summarize.

### 6. Richer state aliases

New `src/presence/agent-state.ts`. Normalize: trim, lowercase, hyphens/spaces → `_`.

| Aliases | Canonical | Asset |
|---|---|---|
| working, running, active, in_progress, busy, thinking | working | `state-working` |
| blocked, error, failed, failure, interrupted | blocked | `state-blocked` |
| waiting, needs_input, needsinput, input, permission, paused, pending | waiting | `state-waiting` |
| done, complete, completed, finished, idle, success, cancelled, canceled | done | `state-idle` (`idle` label) |
| anything else / missing | done | `state-idle` |

Unknown raw strings never appear in `state`, `small_text`, or logs as the Discord label.

`buildActivity` canonicalizes before `AGENT_STATE_LABELS`.

## Module map (delta)

| Path | Role |
|---|---|
| `src/presence/agent-state.ts` | Alias table + `canonicalizeAgentState` |
| `src/presence/agents.ts` | Table, parse, prune, summarize |
| `src/presence/configure.ts` | `applyConfigure` fail-fast patch |
| `src/presence/expiry.ts` | Add `AGENT_RETENTION_MS` |
| `src/presence/settings.ts` | New keys + normalize |
| `src/presence/activity.ts` | Buttons, agent count, canonicalize |
| `src/presence/controller.ts` | `clear()` + hold flag |
| `src/main.ts` | Commands, table, App ID rebuild, typed register |
| `orca-plugin.json` / README / privacy / architecture | Docs + version **0.5.0** |

## Error handling

- Invalid configure Application ID or `openUrl`: no persist, notification, `{ ok: false }`.
- Clear / bridge failures: existing log-and-continue.
- Unparseable agent payload: ignore (do not wipe the table).

## Testing

Bun unit tests only. Fake IPC / fake clock. No live Discord.

Coverage: aliases, garbage → idle, HTTPS button omit/include, configure fail-fast + empty App ID, two `paneKey`s + `showAgentCount`, 30m / 60s prune, Clear hold vs heartbeat vs agent event, manifest commands, panel omits `openUrl`.

## Non-goals

- Focused window/tab (#7)
- Writable panel settings (#10)
- Depending on `nacho.orca-discord-presence`
- Loosening `generic` default
- More than one Discord button
- New Rich Presence assets
