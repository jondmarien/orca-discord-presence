# Consume fork Orca-1…5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `chron0.discord-presence` 0.6.0 that consumes fork Orca-1…5 host APIs with feature-detect fallbacks.

**Architecture:** Keep `buildActivity` as the privacy boundary. Add parsers for readContext / focus / sidecar / diagnostics storage. Panel probes settings/storage. Controller publish order: local IPC → sidecar mailbox → companion HTTP.

**Tech Stack:** TypeScript, Bun test, existing zero-dep Node ESM bundle.

## Global Constraints

- `@author Jonathan Marien` only at tops of files touched/created.
- Version 0.6.0 lockstep: `PLUGIN_VERSION`, `package.json`, `orca-plugin.json`, panel stamp.
- `engines.orca` stays `>=1.4.0`.
- Do not launch Discord. Do not PR `stablyai/orca`.
- Keep existing palette commands. No new one-command-per-toggle.
- Companion remains Discord fallback; sidecar mailbox is not Discord until a UI executor exists.

---

### Task 1: Settings + host-context + focus (pure)

**Files:**
- Create: `src/presence/host-context.ts`, `src/presence/focus.ts`
- Modify: `src/presence/settings.ts`
- Test: `test/presence-settings.test.ts`, `test/presence-host-context.test.ts`, `test/presence-focus.test.ts`

**Interfaces:**
- Produces: `showFocusedSurface`, `focusedSurfaceDetail`, `showAgentType`, `showAgentModel`, `showAgentProfile`; `parseWorkspaceContext`; `parseAgentIdentity`; `resolveMachineName`; `formatFocusedSurface`; `FOCUSED_SURFACE_KINDS`

- [ ] Write failing tests, then implement. Defaults off. `focusedSurfaceDetail` is `'kind' | 'kind+title'`.

### Task 2: Activity + agent table metadata

**Files:**
- Modify: `src/presence/activity.ts`, `src/presence/agents.ts`
- Test: `test/presence-activity.test.ts`, `test/presence-agents.test.ts`

**Interfaces:**
- Consumes: Task 1 types
- Produces: snapshot fields `executionHostKind/Label`, `agentType/Model/Profile`, `focusedSurfaceKind/Title/AtMs`; `AgentSummary` identity from winner slot

- [ ] Write failing privacy tests, then wire `buildState`.

### Task 3: Sidecar transport + controller publish

**Files:**
- Create: `src/presence/sidecar.ts`
- Modify: `src/presence/controller.ts`
- Test: `test/presence-sidecar.test.ts`, `test/presence-controller.test.ts`

**Interfaces:**
- Produces: `PresenceSidecar`, `parseSidecarPlacement`, `createSidecarTransport`; `PresenceSink` includes `'sidecar'`; `status.sidecarMailbox`

- [ ] Write failing controller tests (local / sidecar / bridge), then implement.

### Task 4: Diagnostics storage + panel snapshot fields

**Files:**
- Create: `src/presence/diagnostics-store.ts`
- Modify: `src/presence/panel-snapshot.ts`
- Test: `test/presence-diagnostics-store.test.ts`, `test/presence-panel.test.ts`

**Interfaces:**
- Produces: `DIAGNOSTICS_STORAGE_KEY = 'diagnostics.snapshot'`, `capPanelSnapshotForStorage`; snapshot `fields` include new toggles; `host` probe flags

### Task 5: Worker wiring + panel HTML

**Files:**
- Modify: `src/main.ts`, `src/presence/configure.ts`, `panel/index.html`, `orca-plugin.json`, `src/version.ts`, `package.json`
- Test: `test/entry.test.ts`, `test/presence-configure.test.ts`, `test/presence-panel.test.ts`

- [ ] Manifest: `ui:focus`, `sidecar`, `ui.focus.changed`. Version 0.6.0.
- [ ] Worker: parse readContext extras, focus event, settings poll, storage snapshot, sidecar probe.
- [ ] Panel: probe settings/storage; live poll; writable toggles; fallback copy.

### Task 6: Docs + build

**Files:**
- Modify: `README.md`, `ROADMAP.md`, `docs/privacy.md`, `docs/architecture.md`
- Run: `bun test`, `bun run typecheck`, `bun run build`

---

## Self-review

- Orca-1/2/3/4/5 each have a task.
- Stock fallback documented (manifest reject for 4/5; method probe for 1/2/3).
- No `engines.orca` bump.
- Companion kept.
