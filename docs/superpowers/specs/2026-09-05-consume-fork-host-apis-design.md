# Consume fork Orca-1…5 host APIs

Author: Jonathan Marien  
Date: 2026-09-05

Design for plugin work after GitHub Stack #7 merged on [`jondmarien/orca`](https://github.com/jondmarien/orca) `main`. Tracks [#10](https://github.com/jondmarien/orca-discord-presence/issues/10) (plugin-side after each Orca merge) and [#7](https://github.com/jondmarien/orca-discord-presence/issues/7) (focused-surface presence).

This spec is the approved scope from the implement-as-PR brief (Cloud Agent; no interactive review loop). Official `stablyai/orca` does **not** have these APIs yet. No PR against `stablyai/orca`.

Context7 MCP quota was exceeded; host contracts come from the fork docs and `src/shared/plugins/plugin-host-api.ts` on `jondmarien/orca` `main`.

## Problem

v0.5.0 still behaves as if panels cannot persist settings, `readContext` has no host/agent/focus fields, and dual-host Discord needs the HTTP companion forever. The fork now exposes those surfaces. The plugin should consume them with feature-detect / try-call so a method miss on stock Orca degrades instead of crashing.

## Constraints

- Plugin id stays `chron0.discord-presence`. File-level `@author Jonathan Marien` only on files touched/created.
- Privacy: `detailLevel: generic` remains the default. New identifying fields default **off**.
- Do not launch Discord on the agent machine.
- Keep the HTTP companion (#6) as the Discord-visible fallback. Sidecar UI IPC may still be `not-implemented`.
- Do not dual-publish to Discord (local IPC and companion, or local IPC and a future UI executor).
- Keep existing palette commands (older hosts / no panel). Do not add one new command per new toggle.
- `engines.orca` stays `>=1.4.0` (feature-detect; fork version may still report 1.4.x).
- Version **0.6.0** — `PLUGIN_VERSION` / `package.json` / `orca-plugin.json` / panel stamp in lockstep.
- Tests: `bun test` + `bun run typecheck`. No live Discord.

## Approaches considered

1. **Layered feature-detect on the current modules** (recommended). Keep `buildActivity` as the privacy boundary. Add small parsers (`host-context`, `focus`, `sidecar`, `diagnostics-store`). Panel probes `settings.*` / `storage.*` and falls back to the v0.5 rewrite snapshot. Lowest risk; matches local-then-bridge publish.
2. **Require the fork as a hard `engines.orca` floor.** Cleaner consent story, but the fork still reports 1.4.x and stock users would be blocked even for features that feature-detect. Rejected.
3. **Ship two manifests.** Rejected: one plugin id, one zip.

Recommendation: **(1)**.

## Host contracts (fork source of truth)

`plugin-host-api.ts` on the fork has **both** `settings.*` and `storage.*` as `panel: true`. Docs that say otherwise are stale.

| Orca-N | API | Plugin use |
|---|---|---|
| 1 | Panel `settings.get` / `settings.set` | Interactive settings in the sidebar |
| 2 | Panel `storage.get` / `set` / `delete` / `keys` (64 KiB envelope) | Worker writes `diagnostics.snapshot`; panel polls live logs |
| 3 | `readContext.executionHost?` `{ kind, label }`, `readContext.agent?` `{ type, model, profile }`; optional `agent` on `agent.status.changed` | Machine label + agent identity strings |
| 4 | Capability `ui:focus`; event `ui.focus.changed`; optional `focusedSurface` on `readContext` | #7 focused-surface presence |
| 5 | Capability `sidecar`; `sidecar.resolvePlacement` / `sidecar.publish` | Mailbox when local IPC fails; companion remains Discord fallback |

## Design

### Manifest / consent

Declare `ui:focus` and `sidecar` because they are used. Declare `ui.focus.changed` (fork requires `ui:focus` when that event is listed).

**Stock `stablyai/orca` will reject this manifest** (closed capability/event sets). That is required to consume Orca-4/5 on the fork. v0.5.0 remains the stock-loadable line. Method-level feature-detect still covers Orca-1/2/3 on any host that adds those methods without new capability kinds.

Consent re-prompt (fork copy):

- `ui:focus` — focused UI surface (kind + truncated tab title). Off unless granted.
- `sidecar` — publish sidecar frames so a paired UI client can apply them on the Discord machine.

### Settings (all new fields default off)

| Key | Default | Gate |
|---|---|---|
| `showFocusedSurface` | `false` | Never at `generic`. Toggle off → omit. |
| `focusedSurfaceDetail` | `'kind'` | `'kind+title'` only at `full` |
| `showAgentType` | `false` | `full` only |
| `showAgentModel` | `false` | `full` only |
| `showAgentProfile` | `false` | `full` only |

`machineLabel` still overrides. When `showMachine` and detail ≠ `generic`: `machineLabel` ?? `executionHost.label` ?? `os.hostname()`.

No new palette commands. Panel + optional `presence.configure` args.

### Presence strings

`buildActivity` remains the only module that chooses identifying strings.

State part order when enabled: focused surface · agent type/model/profile · agent count · agent state · terminals · machine.

Focus: host kinds `terminal` / `agent` / `browser` / `editor` / `simulator` / `command-palette` map to short labels. Unknown kinds are dropped (never leaked). Explicit `focusedSurface: null` clears focus fields immediately (does not clear workspace/agent). Missing events use a 60s `ACTIVITY_EXPIRY_MS.long` window so a stale “Terminal” does not stick.

### Panel (Orca-1/2)

Probe `settings.get` and `storage.get`. On success: enable toggles / detail select; persist via `settings.set`; poll `diagnostics.snapshot` (~2s) so logs update without remounting. On `panel_forbidden` / miss: keep v0.5 read-only checkboxes + HTML rewrite + palette.

Worker writes the same redacted snapshot to `storage.set` (`diagnostics.snapshot`, cap ~60 KiB) and still rewrites `panel/index.html` on writable installs.

Worker re-reads `settings.get` on refresh and on a 5s poll so panel writes apply without waiting 90s.

Panel never writes `applicationId`, `bridgeToken`, `bridgeUrl`, `openUrl`, or `machineLabel`.

### Sidecar (Orca-5)

Publish policy:

1. Local IPC handshake succeeds → local only. Clear a previously stored sidecar frame so a future UI executor cannot dual-publish.
2. Local fails → `sidecar.resolvePlacement` (try-call). If `mailboxAvailable`, `sidecar.publish` `{ channel: 'presence', op: 'set', payload: activity }`.
3. Companion still runs when configured — UI Discord IPC is `not-implemented`. That is **not** dual Discord today.
4. If only the mailbox stored: `sink=sidecar`. If companion published: `sink=bridge` and `sidecarMailbox=true`.
5. Clear / stop / disable also `sidecar.publish` `{ op: 'clear' }` when a frame was stored.

### engines.orca

Keep `>=1.4.0`. Document in README + PR: no new floor because methods are probed; fork is required for `ui:focus` / `sidecar` / `ui.focus.changed` to load.

## Testing

Fake host `call` / events. No Discord. Cover privacy gates, stale/null focus, sidecar vs companion vs local, storage cap, panel probe fallbacks, manifest version lockstep.

## Out of scope

- Upstream PRs on `stablyai/orca`.
- Implementing the Electron Discord IPC executor.
- File-path presence beyond host-truncated focus titles.
- Deleting existing palette toggle commands.
