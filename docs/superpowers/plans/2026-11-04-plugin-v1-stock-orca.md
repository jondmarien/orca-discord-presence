# Plugin v1.0.0 on stock Orca — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents for this project MUST be Orca orchestration workers (Sonnet 5.5), not built-in Agent subagents.

**Goal:** Ship "Rich Presence for Discord" 1.0.0 that runs on stock Orca (manifest v2, Host API 1.x) and is listed on onorca.dev.

**Architecture:** The worker (`src/main.ts`) keeps the controller, Discord IPC and companion bridge as they are. Its host edges move to the stock contracts: `workspace.*` events and `agents.list`, native `contributes.settings` plus `settings.onDidChange`, `secrets:own` for the bridge token, and `orca.panels.handle/post` for the panel. The panel drops the custom postMessage protocol and the self-rewriting HTML, and talks through `window.orca`.

**Tech Stack:** TypeScript, Bun (test/build), Node ESM worker, Orca plugin host API 1.3, `orca` CLI 1.4.249 (`orca plugin validate`).

**Spec:** `docs/superpowers/specs/2026-11-04-stock-orca-and-upstream-apis-design.md` (Workstream A, §4). Workstreams B/C (fork rebuild, focus API, client relay, upstream PRs) get their own plans after this ships.

## Global Constraints

- Install identity `jondmarien.discord-presence`. Manifest has **no** `publisher`.
- Display name `Rich Presence for Discord`. License `MIT`.
- `manifestVersion: 2`, `execution: "trusted-worker"`, `engines.orca: ">=1.4.248"`, `pluginApi: 1`, `$schema: "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json"`.
- Version `1.0.0` in `orca-plugin.json`, `package.json`, `src/version.ts`, kept equal (existing test).
- Capabilities exactly: `workspace:read`, `agent:read`, `storage:own`, `settings:own`, `secrets:own`, `notifications:show`.
- Events exactly: `agent.status.changed`, `workspace.removed`, `workspace.changed` (≤4 total, leaves one slot for fork focus).
- No binaries committed (`companion/orca-presence-companion*` stay gitignored). No tracking/analytics.
- Privacy defaults unchanged (`DEFAULT_SETTINGS` values in `src/presence/settings.ts`).
- Every fork/newer host method is guarded by `orca.host.has(name)`. On a missing method the plugin degrades, never throws.
- Pushing to `origin`, tagging, and `gh repo edit` are outward-facing: confirm with the author before Task 9 steps that publish.

## Review Focus

1. Secrets unavailable (Linux `basic_text`, `secrets.protection` → `unavailable`): bridge still works from the settings fallback, and status shows a warning. Pinned in Task 5.
2. `workspace.changed` with `context: null` (no workspace focused): presence falls back to the minimal "Working in Orca" snapshot and doesn't crash or clear the agent table. Pinned in Task 3.
3. Older Orca or a browser client without `agents.list` / `plugin.request`: activation still succeeds, and the panel shows a static "needs Orca desktop" state instead of hanging. Pinned in Tasks 3 and 6.
4. The person edits a setting in Orca's Settings while the worker runs: the controller applies it without a reload, and a changed Application ID rebinds the client. Pinned in Task 4.
5. An agent seeded from `agents.list` and then reported by `agent.status.changed` for the same terminal counts once, not twice. Pinned in Task 2.

---

### Task 1: Hermetic tests (baseline fix)

Baseline today: 2 failures in `test/entry.test.ts`, which time out because a live Vesktop socket under `/run/user/<uid>/app/dev.vencord.Vesktop/` is found and dialed.

**Files:**
- Modify: `src/discord/ipc.ts` (`discordIpcCandidates`)
- Modify: `test/entry.test.ts`, `test/discord-ipc-path.test.ts`

**Interfaces:**
- Produces: env var `ORCA_PRESENCE_DISCORD_IPC` exported as `DISCORD_IPC_ENV` from `src/discord/ipc.ts`. When set, `discordIpcCandidates` returns exactly its `path.delimiter`-separated entries (empty entries dropped) on every platform.

- [ ] **Step 1:** In `test/discord-ipc-path.test.ts`, add `test('ORCA_PRESENCE_DISCORD_IPC overrides candidates')`: `discordIpcCandidates({ platform: 'linux', env: { ORCA_PRESENCE_DISCORD_IPC: '/x/a:/x/b' }, uid: 1000 })` equals `['/x/a', '/x/b']`. Add a win32 variant with `;`.
- [ ] **Step 2:** Run `bun test test/discord-ipc-path.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement the override at the top of `discordIpcCandidates`. Use `path.posix.delimiter` / `path.win32.delimiter` chosen by the `platform` argument, not the host.
- [ ] **Step 4:** In `test/entry.test.ts`, every test that calls `activate` sets `process.env.ORCA_PRESENCE_DISCORD_IPC` to a non-existent path in its temp dir and restores it afterwards, following the existing `ORCA_PRESENCE_LOG_FILE` save/restore pattern.
- [ ] **Step 5:** Run `bun test` (with Vesktop running). Expected: `162 pass, 0 fail`. Run `bun run typecheck`. Expected: clean.
- [ ] **Step 6:** Commit `test: isolate entry tests from live Discord IPC`.

### Task 2: Agent table on stock payloads

**Files:**
- Modify: `src/presence/agents.ts`
- Test: `test/presence-agents.test.ts`

**Interfaces:**
- Produces:
  - `type AgentStatusEvent = { workspaceId: string; paneKey: string; terminalId?: string; state: string; receivedAt: number }` (replaces `worktreeId`).
  - `agentSlotKey(event: Pick<AgentStatusEvent, 'workspaceId' | 'paneKey' | 'terminalId'>): string` → `t:<terminalId>` when `terminalId` is a non-empty string, else `p:<workspaceId>\u001f<paneKey>`.
  - `parseAgentStatusPayload(payload, nowMs)` reads `workspaceId` (string, else `''`), `paneKey`, optional `terminalId`, `state`, `receivedAt`.
  - `parseWorkspaceRemovedId(payload: unknown): string | null` reads `workspaceId` (replaces `parseWorktreeRemovedId`).
  - `parseAgentsList(result: unknown, nowMs: number): AgentStatusEvent[]` maps `agents.list` → `{ agents: [{ terminalId, title, agent, state, stateStartedAt }] }` to events with `workspaceId: ''`, `paneKey: ''`, `terminalId` (rows with null `terminalId` dropped), `receivedAt: stateStartedAt` (fallback `nowMs`). Non-object or non-array input → `[]`.
  - `AgentTable.removeWorkspace(workspaceId: string): boolean` (renamed from `removeWorktree`). When an upsert replaces an existing slot whose `workspaceId` is `''`, it takes the event's `workspaceId`.

- [ ] **Step 1:** Update the existing tests to the renamed fields and functions, and add:
  - `seeded agent then event for same terminalId counts once` (Review Focus 5): seed via `parseAgentsList({ agents: [{ terminalId: 't1', title: null, agent: 'claude', state: 'working', stateStartedAt: 1 }] }, 10)`, then upsert an event `{ workspaceId: 'w1', paneKey: 'tab:leaf', terminalId: 't1', state: 'blocked', receivedAt: 20 }`. Expect `summarize().agentCount === 1`, `agentState === 'blocked'`, and `removeWorkspace('w1') === true`.
  - `parseAgentsList tolerates junk`: `null`, `{}`, `{ agents: 'x' }` all return `[]`.
  - `parseWorkspaceRemovedId reads workspaceId`.
- [ ] **Step 2:** Run `bun test test/presence-agents.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement in `src/presence/agents.ts`. Keep the retention and priority logic unchanged.
- [ ] **Step 4:** Apply the mechanical renames at the `src/main.ts` call sites (`parseWorkspaceRemovedId`, `removeWorkspace`; the event names stay as they are until Task 3). Run `bun test && bun run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: key agent slots by terminal, parse stock workspace payloads`.

### Task 3: Manifest v2, identity, worker events

**Files:**
- Modify: `orca-plugin.json`, `package.json`, `src/version.ts`, `src/main.ts`, `src/presence/log.ts`
- Create: `LICENSE` (MIT, `Copyright (c) 2026 Jonathan Marien`)
- Test: `test/entry.test.ts`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces:
  - `OrcaHost` type in `src/main.ts` gains `host.has(method: string): boolean`, `settings?: { onDidChange(handler: (e: { key: string }) => void): { dispose(): void } }`, `panels?: { handle(name: string, fn: (input: unknown) => unknown): { dispose(): void }; post(name: string, payload: unknown): void }`.
  - `refresh(agentEvent?, options?: { force?: boolean; resume?: boolean; context?: WorkspaceContext | null })`. When `options.context` is provided (including `null`), it is used instead of calling `workspace.readContext`.
  - `LOG_PLUGIN_ID = 'jondmarien.discord-presence'`, `LOG_DIR_NAME = 'jondmarien-discord-presence'`.

Manifest content (all fields beyond Global Constraints):
- `id: "discord-presence"`, `description: "Shows your Orca workspace, branch and agent state on your Discord profile. Every field is opt-in. Not affiliated with Discord."`, `author: { name: "Jonathan Marien", url: "https://github.com/jondmarien" }`, `repository` / `homepage: "https://github.com/jondmarien/orca-discord-presence"`, `license: "MIT"`, `main: "dist/main.js"`.
- Panel `{ id: "presence", title: "Rich Presence", icon: "activity", entry: "panel/index.html" }`.
- The same 15 command ids. Titles get their prefix changed from `Discord Presence:` to `Rich Presence:`.
- `icon`, `cover`, `screenshots`, `settings` come in Tasks 4 and 8.

- [ ] **Step 1:** Rewrite the manifest test in `test/entry.test.ts`: assert there is no `publisher`, plus `manifestVersion === 2`, `execution === 'trusted-worker'`, `engines.orca === '>=1.4.248'`, `license === 'MIT'`, `name === 'Rich Presence for Discord'`, the exact capability set, the exact event set, and the panel object above. Remove the `orca-panel-action` assertion. In the activate test, assert the registered events are `['agent.status.changed', 'workspace.removed', 'workspace.changed']`. Add test `workspace.changed null context publishes minimal snapshot` (Review Focus 2): fire handler with `{ context: null }` after an agent event; controller `status()` reports `agentCount` 1 and no throw. Add test `activate succeeds when host.has returns false for everything` (Review Focus 3).
- [ ] **Step 2:** Run `bun test test/entry.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Write the manifest, `LICENSE`, version bumps to `1.0.0`, and the `log.ts` constants. In `src/main.ts`:
  - replace the `worktree.*` subscriptions with `workspace.removed` (→ `agentTable.removeWorkspace`) and `workspace.changed` (→ `refresh(undefined, { context: payload.context })`);
  - after controller creation, if `orca.host.has('agents.list')`, call it, `parseAgentsList`, and upsert each row before the first fire-and-forget refresh;
  - change the notification titles to `Rich Presence for Discord`;
  - keep `HEARTBEAT_MS` (it still prevents idle reap).
- [ ] **Step 4:** Run `bun test && bun run typecheck && bun run build && orca plugin validate .`. Expected: all pass. `validate` prints `ok`, a `local.discord-presence 1.0.0 (trusted-worker)` line (dev folders use publisher `local`), and no publisher warning.
- [ ] **Step 5:** Commit `feat!: manifest v2, Rich Presence for Discord identity, stock workspace events`.

### Task 4: Native settings

**Files:**
- Modify: `orca-plugin.json` (`contributes.settings`), `src/main.ts`, `src/presence/settings.ts`
- Test: `test/presence-settings.test.ts`, `test/entry.test.ts`

**Interfaces:**
- Produces: `SETTING_KEYS_DECLARED: readonly (keyof PresenceSettings)[]`, meaning every key of `DEFAULT_SETTINGS` except `bridgeToken`. Exported from `settings.ts`.

Declarations: one entry per key in `SETTING_KEYS_DECLARED`, with `type` matching the TS type (`boolean` / `string`) and `default` equal to `DEFAULT_SETTINGS`. Exceptions: `machineLabel` gets type `string` with default `""` (`normalizeSettings` already maps empty to `null`); `detailLevel` gets `enum: ["off","generic","workspace","full"]` and `enumLabels: ["Off","Generic","Workspace","Full"]`; `applicationId` gets `maxLength: 20`; `openButtonLabel` gets `maxLength: 32`; `openUrl` and `bridgeUrl` get `maxLength: 512`. Titles and descriptions are short plain-English (builder's wording). `bridgeUrl`'s description mentions the companion.

- [ ] **Step 1:** Tests:
  - `declared settings match DEFAULT_SETTINGS`: for every key in `SETTING_KEYS_DECLARED`, there is a manifest entry with an equal default (with `""` ↔ `null` for `machineLabel`), and there is no entry for `bridgeToken`.
  - `settings.onDidChange re-reads and applies` (Review Focus 4, in `entry.test.ts`): fake host whose `settings.get` result changes. Fire `onDidChange({ key: 'detailLevel' })`. Expect `controller.settings().detailLevel` updated. Fire for `applicationId`. Expect a log line `discord.app_id_rebind`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Add the declarations. In `main.ts`, extract the existing rebind/apply logic in `persist` into `applySettings(next: PresenceSettings)`. `persist` calls it after writing. If `orca.settings?.onDidChange` exists, subscribe; the handler re-reads `settings.get`, normalizes, and calls `applySettings` (debounced 250 ms so a multi-key `persist` doesn't rebind repeatedly). Also skip `settings.set` for unchanged keys in `persist`.
- [ ] **Step 4:** `bun test && bun run typecheck && orca plugin validate .`. Expected: pass.
- [ ] **Step 5:** Commit `feat: declare settings for Orca's native Settings page`.

### Task 5: Bridge token in secrets

**Files:**
- Create: `src/presence/bridge-token.ts`
- Modify: `src/main.ts`, `src/presence/configure.ts` (the path where `bridgeToken` is set, if any), `src/presence/controller.ts` (status field)
- Test: `test/presence-bridge-token.test.ts`

**Interfaces:**
- Produces:
  - `type TokenStore = 'secrets' | 'settings'`
  - `async function loadBridgeToken(host: { has(m: string): boolean; call(m: string, a?: object): Promise<unknown> }, settingsToken: string): Promise<{ token: string; store: TokenStore; warning?: string }>` — resolution order: `secrets.get({ key: 'bridgeToken' })` when `secrets.protection` → `os-keyring`; else `settingsToken` with `store: 'settings'` and `warning: 'secrets unavailable; bridge token stored in plugin settings'`. Env override (`BRIDGE_ENV`) still wins later through the existing `applyBridgeEnvOverrides`.
  - `async function saveBridgeToken(host, token: string): Promise<TokenStore>` — mirror policy for writes.
  - `PresenceStatus` gains `bridgeTokenStore?: TokenStore` and `warnings?: string[]`, both shown by **Show Status**.

- [ ] **Step 1:** Tests: keyring available → reads secret, store `secrets`; `protection: 'unavailable'` → settings fallback with warning (Review Focus 1); `host.has('secrets.get') === false` → settings fallback; a thrown `secrets.get` → settings fallback, no throw; `saveBridgeToken` writes the matching store.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Wire it into `activate`: load after `settings.get` and set `settings.bridgeToken` before `applyBridgeEnvOverrides`. The configure path writes via `saveBridgeToken`, and never through `settings.set`, when the store is `secrets`.
- [ ] **Step 4:** `bun test && bun run typecheck`. Also confirm `snapshotLeaksSecrets` tests still pass, since the token must never appear in snapshots.
- [ ] **Step 5:** Commit `feat: keep companion bridge token in plugin secrets`.

### Task 6: Panel on the stock frame API

**Files:**
- Rewrite: `panel/index.html` (inline script and styles; no network)
- Modify: `src/main.ts`
- Delete: `src/presence/panel-html.ts`, `test/presence-panel.test.ts` cases that cover HTML embedding/stamping (keep snapshot/redaction cases, moved to `test/presence-panel-snapshot.test.ts`)
- Test: `test/entry.test.ts`

**Interfaces:**
- Consumes: `buildPresencePanelSnapshot` (unchanged), `OrcaHost.panels` (Task 3).
- Produces worker handlers:
  - `presence.snapshot` → `PresencePanelSnapshot` (input ignored).
  - `presence.run` → input `{ command: PanelCommandId }`, runs the same handler as the palette command, and returns `{ ok: boolean; message?: string }`. `PanelCommandId` is a union of `presence.toggle | presence.reload | presence.clear | presence.status | presence.detail-level`. Any other value → throws an `Error` with `code = 'invalid_params'`.
  - `orca.panels.post('presence.snapshot', snapshot)` replaces `publishPanelSnapshot`. Keep the existing 2 s debounce and `immediate` mode semantics.

Panel behavior:
- On load, if `window.orca?.plugin?.request` is missing, show the static note `Open this panel in the Orca desktop app to see live status.` and stop (Review Focus 3).
- Otherwise request `presence.snapshot` with `{ timeoutMs: 5000 }`, render it with the existing status-bar/indicator rendering, and subscribe `orca.plugin.on('presence.snapshot', render)`.
- Buttons call `presence.run`.
- The workspace section uses `orca.on('workspace.changed', …)` when `orca.host.has('events.subscribe')`.
- An "Open settings" hint text points to Orca Settings → Plugins (no deep-link API exists).
- If `snapshot.fields.openUrl` is set, an "Open link" button calls `orca.shell.openExternal(url)` inside the click handler, when `orca.shell` exists.
- Remove the `orca-panel-action` / ping / pong code and the `presence-snapshot` / `plugin-version` script tags.

- [ ] **Step 1:** Tests in `entry.test.ts` with a fake `panels`:
  - `presence.snapshot` handler returns an object with `version === PLUGIN_VERSION` and no bridge token (`snapshotLeaksSecrets(...) === false`);
  - `presence.run` with `presence.toggle` flips `enabled`;
  - `presence.run` with `presence.configure` rejects with `code === 'invalid_params'`;
  - an agent event triggers `panels.post('presence.snapshot', …)` within the debounce window (use fake timers or `immediate` path);
  - static check: `panel/index.html` contains no `orca-panel-action` and no `<script src=` / `http`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the worker side, then the panel. Remove `panel-html.ts` and its build/env references (`ORCA_PRESENCE_PANEL_HTML`, `ORCA_PRESENCE_SKIP_PANEL_WRITE`) from code, tests and README.
- [ ] **Step 4:** `bun test && bun run typecheck && bun run build && orca plugin validate .`. Then manual check: `orca plugin dev` this folder in Orca desktop, open the panel, and see the live indicator. `orca plugin dev request . presence.snapshot` prints a snapshot.
- [ ] **Step 5:** Commit `feat: panel talks to worker via plugin.request and panels.post`.

### Task 7: Remote presence + docs for stock Orca

**Files:**
- Modify: `README.md`, `docs/architecture.md`, `docs/privacy.md`, `companion/README.md`, `ROADMAP.md`

Content requirements:
- Install: from onorca.dev (`https://www.onorca.dev/plugins/jondmarien/orca-discord-presence`) or `orca plugin install` from the Git URL.
- Upgrade note: the identity moved from `chron0.discord-presence` to `jondmarien.discord-presence`. Old settings don't carry over, so uninstall the old copy.
- "Where it runs" table copied from the spec §3.1 rule: paired clients and `orca serve` run plugins on the host, so Discord on Windows needs the companion. Vesktop on the same Linux host uses local IPC.
- Companion runs from source (`bun run companion`). Building a binary is optional and local only.
- Settings are now under Orca Settings. The bridge token is set with **Rich Presence: Configure** (stored in secrets).
- Remove every mention of the fork-only panel bridge, devPluginPaths snapshot rewrites, and the `chron0` identity, except the upgrade note.
- `ROADMAP.md`: focus (#7) and client relay listed as "needs Orca host API (in progress on fork)".

- [ ] **Step 1:** Edit the docs.
- [ ] **Step 2:** `grep -rn "chron0\|orca-panel-action\|Discord Presence:" README.md docs companion ROADMAP.md src panel`. Expected: only the upgrade-note hit.
- [ ] **Step 3:** Commit `docs: stock Orca install, remote presence via companion`.

### Task 8: Listing assets

**Files:**
- Create: `assets/icon.png` (256×256, ≤256 KB, from `assets/orca.png`), `assets/cover.png` (1600×1000, ≤1 MB), `assets/screenshots/*.png` (≥1280×800, ≤1536 KB each, total images ≤8 MB)
- Modify: `orca-plugin.json` (`icon`, `cover: { path, alt }`, `screenshots: [{ path, alt, caption }]`)

- [ ] **Step 1:** Generate the icon and cover with ImageMagick (`magick assets/orca.png -resize 256x256 -strip assets/icon.png`; cover: compose the icon over a dark `#1e1f22` 1600×1000 canvas with the title text). Check the sizes with `identify` and `du -k`.
- [ ] **Step 2 (author, manual):** Capture 2–4 screenshots at ≥1280×800: the Discord profile showing presence, the Rich Presence panel, and Orca Settings for the plugin. Save them to `assets/screenshots/`. The agent waits for these files.
- [ ] **Step 3:** Add the manifest fields. Run `orca plugin validate .`. Expected: ok, no image errors.
- [ ] **Step 4:** Commit `chore: listing icon, cover and screenshots`.

### Task 9: Release

- [ ] **Step 1:** Run the full gate: `bun test && bun run typecheck && bun run build && orca plugin validate .`. Also verify `git ls-files | grep -E '\.(exe|node|zip|tar|gz)$|orca-presence-companion$'` is empty. Commit `dist/main.js` if the build changed it.
- [ ] **Step 2 (manual smoke, author + agent):**
  - Install the built folder with `orca plugin dev` on the Linux desktop with Vesktop running: local IPC shows presence.
  - On the Windows desktop paired to Linux, with the companion running on Windows and the bridge enabled: Discord on Windows shows presence.
  - On `orca serve` over SSH with the companion reachable through a tunnel: presence shows.
  - Record the results in the PR description.
- [ ] **Step 3 (confirm with author first):** Push the branch and open a PR to `main` in `jondmarien/orca-discord-presence`. After merge: `git tag -a v1.0.0 -m v1.0.0 && git push origin v1.0.0`, then `gh repo edit jondmarien/orca-discord-presence --add-topic orca-plugin`.
- [ ] **Step 4:** Within about an hour, open `https://www.onorca.dev/plugins/jondmarien/orca-discord-presence`. Expected: listed as Community, with no validator errors. If it is rejected, fix what the status page reports, bump to `1.0.1`, and re-tag.
