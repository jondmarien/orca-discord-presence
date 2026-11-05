# Stock-Orca release, fork rebuild, and upstream host-API PRs — design

- **Date:** 2026-11-04
- **Author:** Jonathan Marien (with Claude)
- **Repos:** `jondmarien/orca-discord-presence` (plugin), `jondmarien/orca` (fork), `stablyai/orca` (upstream)
- **Status:** Approved 2026-11-04

## 1. Intent

The plugin should be installable by anyone from [onorca.dev/plugins](https://www.onorca.dev/plugins) on **stock Orca**. The fork of Orca is temporary scaffolding: it exists only to develop and dogfood host APIs that are later proposed upstream. Remote presence is a daily-use feature for the author and must not regress.

### Why now

Upstream Orca moved ~8,800 commits since the fork branched (2026-09). In that time it shipped manifest format 2, Host API 1.3, a public plugin directory, and most of the host surface the fork added (panel settings/storage, panel→worker requests, agent listing, workspace-changed events). PR [stablyai/orca#19023](https://github.com/stablyai/orca/pull/19023) is conflicted, unreviewed, and about half redundant.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Plugin v1.0.0 runs on stock upstream Orca (manifest v2, Host API 1.x) and is listed on onorca.dev.
2. Remote presence keeps working on stock Orca for the author's topology (§3).
3. Fork `main` becomes upstream `main` plus only the host APIs upstream still lacks, rebuilt on current upstream architecture.
4. Plugin lights up fork-only features through runtime feature detection — one plugin build works on stock and fork.
5. #19023 is replaced by small, single-topic upstream PRs, each with its own linked issue.

**Non-goals**

- Rebasing the old fork commits onto upstream. They are re-implemented, not replayed.
- Re-proposing APIs upstream now covers (panel `settings.*` / `storage.*`, agent labels in `readContext`).
- New presence features beyond what exists on `main` and on the `focus-host-*` branches.

**Anti-goals (failure even if it "works")**

- A plugin that only works on the fork.
- Losing the author's existing fork work with no recoverable reference.
- Orca core code that speaks Discord IPC. Upstream requires provider-neutral behavior; Discord-specific logic stays in the plugin.
- Plugin listing rejected or flagged for impersonation, binaries, or a publisher mismatch.

## 3. Constraints and facts

### 3.1 Author's topology

| Machine | Orca role |
| --- | --- |
| Linux desktop | Orca desktop; runtime host for its workspaces |
| Windows desktop | Orca desktop paired to and controlling the Linux desktop |
| Mac mini | Orca desktop |
| SSH server | `orca serve` (headless) |

Upstream rule (`plugin-host-api.md`, Hooks): *"A paired client reaching a remote Orca server is decided by that server's plugins."* So when Windows controls Linux, **the plugin worker runs on Linux**, and with `orca serve` it runs on the SSH server. Discord's local IPC socket/pipe exists only on the machine where Discord runs. That gap is what the companion bridge (stock) and the client relay (fork, §6.2) close.

### 3.2 Upstream plugin platform (main @ `c9b480fd`, 2026-11-04)

- Manifest format 2: required `execution` (`trusted-worker` for us); unknown keys are rejected; `publisher` is deprecated and derived from the repo owner. Leaving `publisher` out needs `engines.orca >= 1.4.246`.
- Capabilities: `workspace:read`, `agent:read`, `storage:own` (renamed from `storage`), `settings:own`, `notifications:show`, `secrets:own`, and others. There is no `events:subscribe` capability any more; events need their domain's read capability.
- Events (max 4 per manifest): `workspace.created`, `workspace.removed`, `agent.status.changed`, `workspace.changed`. The `worktree.*` names are gone, and the payloads now use `workspaceId`.
- Host methods we use or adopt: `workspace.readContext`, `agents.list` (1.2), `settings.get/set`, `storage.*`, `secrets.*`, `notifications.show`, `plugin.request` + `orca.panels.handle` (1.2), `shell.openExternal` (1.1), `statusBar.update` (1.2). Use `orca.host.has(name)` before relying on anything newer than `engines.orca`.
- `contributes.settings` (1.4.246) renders a native Settings page; code reads it with `settings.get`.
- `main` may be `.ts` (1.4.246); bundled output is allowed when the source is in the repo.

### 3.3 Listing rules (onorca.dev/plugins/add, plugin-listing-policy.md)

- Public, non-fork GitHub repo with topic `orca-plugin` and a `vX.Y.Z` tag. The directory pins the tag's commit.
- Manifest v2; must pass `pnpm validate:plugin <path>` from an Orca checkout.
- License in the manifest or a detectable `LICENSE` file. **The repo has none today.**
- No binaries: executables, native modules, archives or symlinks. The compiled companion (`companion/orca-presence-companion[.exe]`) must never be committed. It is gitignored today; keep it that way.
- `publisher` must equal the repo owner (`jondmarien`) or be omitted. Today it is `chron0`.
- No impersonation of other brands. The current name "Discord Rich Presence" leads with the brand.
- No tracking or analytics. Unobfuscated code only.
- Optional cover (16:10, ≥800×500, ≤1 MB) and up to 6 screenshots (≥1280×800).

### 3.4 Upstream contribution rules

- Each outside-contributor PR **must link an issue** (`Fixes #N`), or it is ignored.
- PRs must be single-topic and cross-platform (macOS/Linux/Windows), and must work for SSH and remote servers. The PR template needs visual proof, risk level, and AI disclosure.
- Upstream already uses the word "sidecar" for `runtime-environment-sidecar.ts`, an unrelated store. Our feature must use a different name.

## 4. Workstream A — Plugin v1.0.0 on stock Orca

Repo `jondmarien/orca-discord-presence`, starting from `main` (0.5.0).

### A1. Manifest v2

- `manifestVersion: 2`, `execution: "trusted-worker"`, `$schema` set, `publisher` removed, `license` added, `author`/`repository`/`homepage` filled in, and `engines.orca` raised to the newest `Since` of the fields used (≥ `1.4.246` for settings/no-publisher, `1.4.248` if status bar items are used).
- Capabilities: `workspace:read`, `agent:read`, `storage:own`, `settings:own`, `notifications:show`, plus `secrets:own` for the bridge token (A4).
- Events: `agent.status.changed`, `workspace.removed`, `workspace.changed`. Drop `workspace.created`: it only triggered a refresh, which `workspace.changed` now covers, and dropping it leaves room for `ui.focus.changed` (fork) within the 4-event cap.
- Display name: "Rich Presence for Discord" (§9).

### A2. Worker migration

- Event payloads: `worktreeId` → `workspaceId`. `parseWorktreeRemovedId` becomes the `workspace.removed` parser.
- On activate, seed the agent table from `agents.list` so agents running before activation show up. `agent.status.changed` keeps it current.
- Subscribe to `workspace.changed` for context. The heartbeat stays only as long as the Discord session and elapsed-timer refresh need it; the builder decides the interval.
- Keep the current privacy defaults (generic detail level, opt-in fields) unchanged.

### A3. Settings and panel

- Declare user-facing settings in `contributes.settings` so they appear in Orca's native Settings: enabled, detail level (enum), application ID, the show-* toggles, machine label, bridge enabled/URL, open URL/button/label, debug logging. The keys stay as they are in `src/presence/settings.ts`.
- Rewrite the panel onto the stock frame API. The custom `PANEL_ACTION` postMessage bridge is replaced by `window.orca.host.call(...)` for settings and `plugin.request(name)` → `orca.panels.handle(name)` for worker actions (status, reload, clear, configure). The panel becomes a status-plus-quick-actions view; editing lives in native Settings, with the panel's form kept only where native settings can't express it. That last call is left to the builder.
- "Open" button URLs go through `shell.openExternal` where a click starts them.

### A4. Remote presence on stock Orca

- The companion HTTP bridge (`companion/`) is the stock-Orca remote path. The worker runs on the runtime host (Linux desktop or SSH server) and POSTs to the companion on the Discord machine, reached over LAN or an SSH tunnel as documented today.
- The bridge token moves from settings to `secrets:own`. If `secrets.protection` reports `unavailable` (e.g. Linux `basic_text`), fall back to the existing settings field and warn in the status output.
- Ship the companion as source, run with `bun run companion`. Document how to build a binary locally. No binaries go in the repo or in releases referenced by the listing.

### A5. Feature detection for fork APIs

- Port the consumer logic from the unmerged `focus-host-8-landed-f66c` branch (0.6.x), adapted to the fork's **new** API shapes (§6).
- Gate every fork-only call behind `orca.host.has(...)`. On stock Orca the plugin behaves exactly as A1–A4.
- Fork-only manifest entries (a `ui:focus` capability, a `ui.focus.changed` event) **cannot** go in the listed manifest, because stock Orca rejects unknown capability kinds. Fork-only focus therefore uses polling (`ui.readFocus`, feature-detected) in the listed build. A fork-dev manifest variant can declare the event, generated at build time and never published. **Builder: verify against the fork that host methods can be called without a manifest-declared capability; if not, the fork-dev manifest variant is the only route and the listed build simply doesn't get focus until upstream merges it.**

### A6. Identity change

- Install identity changes from `chron0.discord-presence` to `jondmarien.discord-presence`. Orca scopes storage, settings and secrets per identity, so existing settings will not carry over. The release notes say so; no migration code (my call — a one-person install base doesn't justify it).

### A7. Listing

- Add `LICENSE`, a cover, and 2–4 screenshots taken from the author's existing Discord smoke shots.
- Run `pnpm validate:plugin` from an upstream checkout until it is clean. Add the `orca-plugin` topic and tag `v1.0.0`, then confirm the onorca.dev status page shows the plugin as listed.

## 5. Workstream B — Fork rebuild

Repo `jondmarien/orca`.

1. **Preserve:** tag the current `main`, `develop` and `feat/plugin-host-presence-apis` heads as `archive/2026-09-main`, `archive/2026-09-develop` and `archive/2026-09-pr-19023`, and push the tags before anything else.
2. **Reset:** set fork `main` to upstream `main`. This is a force-push and needs the author's explicit go-ahead at execution time. `develop` is retired or reset the same way.
3. **Re-implement** only the still-missing APIs (§6), each on its own branch off upstream `main`, following current upstream structure (`src/main/plugins/plugin-service-host-call.ts`, `src/shared/plugins/*`, generated docs via `pnpm generate:plugin-schemas`).
4. **Integrate:** merge the feature branches into fork `main` for dogfooding. Keep each branch rebased on upstream so it can become an upstream PR unchanged.
5. **Verify:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, plus a manual smoke of the plugin on Linux desktop + Windows paired client + `orca serve`.
6. Pick one local dev checkout (`~/src/orca` or `~/Projects/orca`); add an `upstream` remote. Builder's choice.

## 6. New host APIs (fork first, then upstream)

### 6.1 UI focus — `ui:focus`

Re-implementation of fork PRs #5/#8 on current upstream:

- Capability `ui:focus` (opt-in, re-prompts consent).
- Method `ui.readFocus` (worker and panel) → `{ focusedSurface }`.
- Event `ui.focus.changed` → `{ focusedSurface, receivedAt }`.
- `focusedSurface`: `{ kind: 'terminal' | 'agent' | 'browser' | 'editor' | ..., title: string | null, workspaceId?: string | null, agentId?: string | null }` with the existing privacy rules: titles reduced to a basename or hostname, capped at 80 bytes; path-bearing ids become session-scoped opaque tokens; `null` when the window is unfocused.
- Join key: `agentId` joins `agent.status.changed.paneKey`. The id-field naming follows upstream's `workspaceId` (not `worktreeId`).
- Dropped compared with the old PR: adding `focusedSurface` to `readContext`. One delivery path is enough, and it keeps `readContext` unchanged upstream. *My call; revisit if upstream reviewers ask for it.*

### 6.2 Client relay (replaces "sidecar mailbox")

Problem: a plugin worker on a runtime host needs to hand something to the same plugin on the paired desktop client that the person is sitting at.

Provider-neutral design, so Orca core never touches Discord:

- The plugin is installed on both machines. The worker on the runtime host calls `relay.publish({ channel, op: 'set' | 'clear', payload })`, with the JSON payload capped at 8 KiB.
- The host keeps the latest frame per plugin+channel and forwards it to connected paired desktop clients that advertise the relay capability.
- On each such client, Orca delivers the frame to **that client's own instance of the same plugin** as an event `relay.received` (new capability, e.g. `relay:client`). The plugin worker there applies it to local Discord IPC.
- Only frames cross the wire: no raw IPC bytes, secrets or storage. Older clients and mobile simply don't advertise the capability. No protocol version bump; it is a capability-advertised optional method, as in the old design.
- Plugin decision order: local Discord IPC on the host → relay to a paired client (if `relay.publish` exists and a client is attached) → companion bridge. Never dual-publish the same activity.
- `orca serve` on the SSH server still needs either the relay (when a desktop is paired to it) or the companion.

**This needs an upstream issue and design discussion before code.** It is the riskiest API: cross-machine, consent, and plugin-to-plugin trust. The exact capability and method names are left to the builder and the upstream discussion.

### 6.3 Agent prompt kind (added 2026-11-04, after v1.0.0)

Problem: plugins get only `working | blocked | waiting | done`. Orca knows internally when an agent is asking the person a question: it keeps the `AskUserQuestion` input as `interactivePrompt` on the agent-status entry. `projectPluginAgentStatusChangedPayload` (`src/main/plugins/plugin-agent-status-event.ts`) drops that detail, so a question looks the same as any other wait or permission prompt.

Proposal, additive inside `pluginApi` 1:
- An optional `prompt?: 'question' | 'permission'` field on the `agent.status.changed` payload and on each `agents.list` row. It is present only while that prompt is pending, and its meaning is coarse: it never carries the question text, the options or the tool input.
- Gated by the existing `agent:read` capability. No new consent is needed, because it reveals less than `title` already does.
- The plugin feature-detects the field. When it is `question`, the plugin shows the **question** state (Discord `state-question-v2`, its own panel colour). Without it, questions keep showing as waiting or blocked.
- Fork first, then upstream as its own small issue and PR, after v1.0.0 ships.

### 6.4 Dropped

- Panel `settings.*` / `storage.*`: upstream has them.
- Agent labels in `readContext`: `agents.list` covers them.

## 7. Workstream C — Upstream

1. Comment on #19023 explaining that upstream now covers most of it, link the new issues, and close it. The text is shown to the author before posting.
2. Issue + PR **Focus API** (§6.1). Reuse #19020 if its wording fits; otherwise open a new issue.
3. Issue first, PR after maintainer signal: **Client relay** (§6.2).
4. Issue + PR **Agent prompt kind** (§6.3), after v1.0.0. It is small and additive, so it may land before the relay.
4. Each PR follows the upstream template: ELI5, linked issue, tests that fail without the change, visual proof (screen capture of Discord + Orca), risk level, AI disclosure.

## 8. Sequencing

1. **A** — plugin v1.0.0 on stock, listed. This delivers value on its own and unblocks everyone else.
2. **B** steps 1–2 (preserve + reset), then 6.1 focus on the fork; plugin v1.1 consumes it via detection.
3. **C** focus issue/PR.
4. 6.2 relay: upstream issue first, fork implementation in parallel, plugin consumes via detection, then PR.

Implementation may use Orca orchestration workers (Sonnet 5.5) for independent tasks, per the author's instruction.

## 9. Author decisions (2026-11-04)

1. **License:** MIT (`LICENSE` file + `"license": "MIT"`).
2. **Display name:** "Rich Presence for Discord".
3. **Discord location:** usually Windows (the paired client), so the relay/companion path is the daily path. Sometimes Vesktop runs on the Linux machine (Arch), where local IPC on the runtime host applies, including the existing Vesktop Flatpak/socket path detection.
4. **Fork reset:** force-pushing fork `main` (and `develop`) is OK. **Do not force-push or rewrite `feat/plugin-host-presence-apis`**, the branch behind #19023; leave it as is and only close the PR with a comment.
5. Install-id change and the calls in §10 are approved.

## 10. Calls made by Claude (please check)

- Re-implement rather than rebase the fork.
- Drop `workspace.created` to stay within the 4-event cap.
- No settings migration across the identity change.
- Bridge token moves to `secrets:own`, with a fallback.
- `focusedSurface` stays out of `readContext` in the new focus API.
- Client relay delivers to the plugin's own instance on the client, not to an Orca-core Discord executor.
- Companion ships as source only.
