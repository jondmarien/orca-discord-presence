# Issue #15 Clear / Button / Configure / Multi-agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship issue #15 on `chron0.discord-presence` v0.5.0: Clear, opt-in Discord button, command-first configure, multi-agent summary, retention, richer state aliases.

**Architecture:** Keep `buildActivity` as the privacy boundary. Add an in-memory agent table keyed by worktree/pane, canonicalize states before labels, attach at most one HTTPS `{ label, url }` button, and add a controller Clear that holds automatic republish until the next intent. Recreate the Discord IPC client only when Application ID changes.

**Tech Stack:** TypeScript, Bun test/build, existing zero-dep Discord IPC client, Orca `pluginApi` 1.

## Global Constraints

- Plugin qualified id stays `chron0.discord-presence`.
- File-level JSDoc `@author Jonathan Marien` only; `@date 2026-09-05`.
- `detailLevel: generic` remains the default; project/branch stay gated.
- Discord buttons: send `{ label, url }`, max 2 (this plugin sends 0 or 1), label 1–32, URL 1–512, HTTPS only.
- Never persist or transmit secrets in `openUrl`; reject URL userinfo.
- Unknown agent states map to idle; never leak raw unknown strings.
- Keep existing `state-*` assets only.
- Tests: `bun test` with no live Discord.
- Version **0.5.0** in `src/version.ts`, `package.json`, `orca-plugin.json`, README.
- Rebuild and commit `dist/main.js`.
- Panel configure form is out of scope (#10). Read-only snapshot checkboxes for new booleans are OK.

---

## File structure

- Create: `src/presence/agent-state.ts` — alias map + `canonicalizeAgentState`
- Create: `src/presence/agents.ts` — parse / table / summarize
- Create: `src/presence/configure.ts` — `applyConfigure`
- Create: `test/presence-agent-state.test.ts`
- Create: `test/presence-agents.test.ts`
- Create: `test/presence-configure.test.ts`
- Modify: `src/presence/expiry.ts` — `AGENT_RETENTION_MS`
- Modify: `src/presence/settings.ts` — new keys
- Modify: `src/presence/activity.ts` — buttons, count, canonicalize
- Modify: `src/presence/controller.ts` — `clear` + hold
- Modify: `src/main.ts` — commands, table, rebuild client
- Modify: `src/presence/panel-snapshot.ts` + `panel/index.html` — new boolean fields only
- Modify: tests, README, privacy, architecture, ROADMAP, version files, `dist/main.js`

### Task 1: State aliases

**Files:**
- Create: `src/presence/agent-state.ts`
- Test: `test/presence-agent-state.test.ts`

**Interfaces:**
- Produces: `export type CanonicalAgentState = 'working' | 'blocked' | 'waiting' | 'done'`
- Produces: `export function canonicalizeAgentState(raw: string | undefined): CanonicalAgentState`

- [ ] **Step 1: Write the failing test** in `test/presence-agent-state.test.ts` covering running/active→working, error/failed→blocked, needs_input→waiting, complete/finished→done, garbage→done, case/hyphen normalization.

- [ ] **Step 2: Run `bun test test/presence-agent-state.test.ts`** — expect FAIL (module missing).

- [ ] **Step 3: Implement `canonicalizeAgentState`** with the alias table from the spec.

- [ ] **Step 4: Re-run the test** — expect PASS.

- [ ] **Step 5: Commit** `feat: canonicalize richer agent state aliases`

### Task 2: Retention constants + agent table

**Files:**
- Modify: `src/presence/expiry.ts`
- Create: `src/presence/agents.ts`
- Test: `test/presence-expiry.test.ts`, `test/presence-agents.test.ts`

**Interfaces:**
- Consumes: `canonicalizeAgentState`, `isActivityFresh`
- Produces: `AGENT_RETENTION_MS = { stale: 1_800_000, done: 60_000 }`
- Produces: `parseAgentStatusPayload(payload, nowMs)`, `createAgentTable(...)`, `summarize` / `prune` / `upsert` / `removeWorktree`

- [ ] **Step 1: Failing tests** for 30m stale / 60s done prune, two paneKeys, aggregate blocked>waiting>working>done, `showAgentCount` input (`agentCount`), missing ids → one slot, unparseable payload ignored.

- [ ] **Step 2: Run tests** — expect FAIL.

- [ ] **Step 3: Implement table + expiry constants.** Schedule the next prune with injectable timers.

- [ ] **Step 4: Tests PASS.**

- [ ] **Step 5: Commit** `feat: multi-agent table with 30m/60s retention`

### Task 3: Settings + configure + openUrl

**Files:**
- Modify: `src/presence/settings.ts`
- Create: `src/presence/configure.ts`
- Test: `test/presence-settings.test.ts`, `test/presence-configure.test.ts`

**Interfaces:**
- Produces settings keys: `openUrl`, `showOpenButton`, `openButtonLabel`, `showAgentCount`
- Produces: `DEFAULT_OPEN_BUTTON_LABEL = 'Open Orca'`
- Produces: `normalizeOpenUrl`, `normalizeOpenButtonLabel`
- Produces: `applyConfigure(current, args) => { ok: true, settings, changed } | { ok: false, error }`

- [ ] **Step 1: Failing tests** — defaults off/empty; HTTPS kept; http/javascript/userinfo rejected; empty App ID → shipped; junk App ID fail-fast; no-args is no-op.

- [ ] **Step 2: Run tests** — expect FAIL.

- [ ] **Step 3: Implement normalize + applyConfigure.**

- [ ] **Step 4: Tests PASS.**

- [ ] **Step 5: Commit** `feat: configure path for App ID and openUrl`

### Task 4: Activity buttons, count, aliases

**Files:**
- Modify: `src/presence/activity.ts`
- Test: `test/presence-activity.test.ts`

**Interfaces:**
- Consumes: `canonicalizeAgentState`, `normalizeOpenUrl` (settings already normalized)
- Produces: `DiscordActivity.buttons?: { label: string; url: string }[]`
- Produces: `PresenceSnapshot.agentCount?: number`

- [ ] **Step 1: Failing tests** — running→working asset; garbage→idle and serialized JSON has no raw state; button only when flag + https; omitted otherwise; `2 agents · working` when `showAgentCount`.

- [ ] **Step 2–4: RED/GREEN.** `buttons` omitted when empty. Label clamped to 32.

- [ ] **Step 5: Commit** `feat: Discord activity button and agent-count copy`

### Task 5: Controller Clear hold

**Files:**
- Modify: `src/presence/controller.ts`
- Test: `test/presence-controller.test.ts`

**Interfaces:**
- Produces: `clear: () => Promise<void>`
- Produces: `PresenceStatus.heldClear: boolean`
- Produces: `update(next, options?: { resume?: boolean })`
- Produces: `forceTransmit(resume?: boolean)` — heartbeat passes false; Show Status true
- `setSettings` / `reload` lift the hold

- [ ] **Step 1: Failing tests** — clear sends null local + bridge without `enabled: false`; heartbeat force does not republish; agent `update(..., { resume: true })` does; second clear is idempotent.

- [ ] **Step 2–4: RED/GREEN.**

- [ ] **Step 5: Commit** `feat: presence.clear holds automatic republish`

### Task 6: Worker wiring, panel, docs, version, dist

**Files:**
- Modify: `src/main.ts`, `orca-plugin.json`, `src/version.ts`, `package.json`, panel + docs + tests

**Interfaces:**
- `OrcaHost.commands.register(id, handler: (args?: Record<string, unknown>) => Promise<unknown>)`
- Commands: `presence.clear`, `presence.configure`, `presence.toggle-open-button`, `presence.toggle-agent-count`
- Recreate client+controller when persisted `applicationId` changes

- [ ] **Step 1: Failing entry tests** for new command ids and version `0.5.0`.

- [ ] **Step 2–4:** Wire table into `refresh`, implement commands, panel checkboxes (no `openUrl`), README/privacy/architecture/ROADMAP, rebuild `dist/main.js`.

- [ ] **Step 5:** `bun test && bun run typecheck && bun run build` all green. Commit `feat: wire #15 commands and bump to 0.5.0`

---

## Self-review

1. **Spec coverage:** Clear, button, configure, multi-agent, retention, aliases, privacy default, version, tests without Discord — each has a task.
2. **Placeholders:** none.
3. **Types:** `CanonicalAgentState`, `applyConfigure`, `heldClear`, `buttons: { label, url }[]` stay consistent across tasks.
