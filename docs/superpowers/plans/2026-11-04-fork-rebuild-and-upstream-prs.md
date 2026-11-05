# Fork rebuild + upstream PRs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`. Subagents are Orca orchestration **terminal** workers (Sonnet 5.5).

**Goal:** a clean fork on current upstream `main`, then upstream PRs for the issues filed on 2026-11-04, one API each:

| Issue | API |
| --- | --- |
| stablyai/orca#38340 | prompt kind |
| #38341 | UI focus |
| #38342 | panels in paired clients |
| #38343 | client relay |

**Architecture:** one branch per API off `upstream/main` in `~/Projects/orca`. The fork's `main` is upstream plus an integration merge, used only for dogfooding. Each plugin follow-up ships as its own plugin PR (1.1.x) that feature-detects the API.

**Spec:** `docs/superpowers/specs/2026-11-04-fork-rebuild-and-upstream-prs-design.md`. §2 lists upstream's contribution rules. Every task below must follow them.

## Global Constraints

- PR body uses `.github/pull_request_template.md` verbatim, with every section filled:
  - `Fixes #<issue>`
  - Visual Proof: a screen capture, or `N/A` with a reason
  - Risk level and back-out
  - AI Disclosure: "Claude Code (Claude Opus 5.5 coordinator, Claude Sonnet 5.5 workers) + human review. Author: Jonathan Marien (jondmarien)"
  - Author X handle: **`<TBD from author>`**
- PR title is the squash subject: `feat(plugins): <outcome in plain words>`.
- Branch names: `feat/plugin-agent-prompt-kind`, `feat/plugin-ui-focus`, `feat/plugin-panels-paired-clients`, `feat/plugin-client-relay`.
- Before **every** push: `pnpm check:changed` (never `--no-verify`). Before opening a PR, run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` locally, or explain any part that CI must cover.
- New host-API surface uses `since: 1.4` (Host API minor 3 → 4). Never bump `package.json` version.
- Regenerate docs with `pnpm generate:plugin-schemas`. Never hand-edit generated docs.
- Tests: only ones that fail when the change is reverted and hard-code expected values, at the layer that owns the behavior. No copy, i18n or CSS tests.
- Comments: one line, why only. Concrete file names.
- Every change states its macOS / Linux / Windows, SSH/remote, mobile and folder-workspace impact in the PR Review section.
- Outward actions need the author's OK at each step: force-pushes, PR creation, and closing #19023 (which happens after PR 1 is up).

## Review Focus

1. Remote/paired hosts: a prompt-kind or focus value must be computed on the host that owns the agent or window. An SSH or paired client must not see stale or foreign values.
2. Older plugins and older hosts: new fields are optional. A plugin that never reads them behaves exactly as before. `orca.api.minor` reports 4 only once the new methods exist.
3. Privacy: no question text, option text, tool input, path or URL in any new field. Focus titles are reduced (basename or hostname, ≤80 bytes).
4. Consent: `ui:focus` re-prompts; prompt kind does not (it is covered by `agent:read`).
5. CI flakiness: upstream runs large sharded suites. Use `gh pr checks --watch`, and rerun only failed jobs, per `docs/agents-md-refs/git-workflow.md`.

---

## Part A. Fork rebuild

### Task A1. Archive and reset the fork

- [ ] `cd ~/Projects/orca && git remote add upstream https://github.com/stablyai/orca.git || true && git fetch upstream origin`
- [ ] Tag and push the archives:
  - `archive/2026-09-main` → `origin/main`
  - `archive/2026-09-develop` → `origin/develop`
  - `archive/2026-09-pr-19023` → `origin/feat/plugin-host-presence-apis`
  - then `git push origin --tags`
- [ ] Verify: `git ls-remote origin 'refs/tags/archive/*'` lists all three.
- [ ] **Ask the author**, then run `git push --force origin upstream/main:main`. Reset `develop` the same way (or delete it, as the author chooses). Do not touch `feat/plugin-host-presence-apis`.
- [ ] Verify: `gh api repos/stablyai/orca/compare/main...jondmarien:orca:main -q .ahead_by` is `0`.
- [ ] Local checkout: `git switch main && git reset --hard upstream/main && corepack enable && pnpm install && pnpm -C mobile install --frozen-lockfile`. Smoke-run `pnpm dev`: Orca opens, and the plugin loads with `orca plugin dev load <plugin dir>`.

## Part B. PR 1: agent prompt kind (#38340)

### Task B1. Project `prompt: 'question'` to plugins

**Files:**
- Modify: `src/main/plugins/plugin-agent-status-event.ts` (`projectPluginAgentStatusChangedPayload`)
- Modify: `src/main/plugins/workers/plugin-workspace-projection.ts` (`projectPluginWorkspaceAgents`)
- Modify: the shared event and `agents.list` result schemas in `src/shared/plugins/` (find them with `rg "mainAgent" src/shared/plugins`)
- Regenerate: `docs/reference/plugin-host-api.md`, `docs/schemas/plugins/*`, `resources/plugins/types/orca-host.d.ts`
- Update: `skill-guides/orca-plugin-authoring/references/host-api.md` if it lists event payloads; the host-API minor constant (rg `minor: 3` in `src/shared/plugins/workers/plugin-host-api-major.ts` or similar)
- Test: next to the projection, e.g. `src/main/plugins/plugin-agent-status-event.test.ts`

**Interfaces:**
- `PluginAgentStatusChangedPayload` gains `prompt?: 'question'`.
- `agents.list` rows gain `prompt?: 'question'`.
- The derivation reuses `src/shared/agent-status/contracts/agent-pending-prompt.ts`:
  - `hookRowAgentPhase(row) === 'needs-you'`
  - and `parseAskFromStatus(row.interactivePrompt, row.toolName)` returns an ask
  - then `'question'`
  - otherwise omit the field

  Export a small `readPluginPromptKind(row): 'question' | undefined` from a concretely named file, e.g. `src/shared/plugins/plugin-agent-prompt-kind.ts`. Do not duplicate parsing.

- [ ] **Step 1:** Tests, each with hard-coded rows:
  - a needs-you row carrying an `AskUserQuestion` `interactivePrompt` projects `prompt: 'question'`
  - a needs-you approval envelope projects **no** `prompt`
  - a working row projects no `prompt`
  - the projected payload never contains the question text (`JSON.stringify` does not include it)
  - the same three cases for `agents.list` rows
- [ ] **Step 2:** `pnpm test <the test files> --maxWorkers=2`. Expected: FAIL.
- [ ] **Step 3:** Implement. Bump the host-API minor to 4 and set `since: 1.4` on the new field.
- [ ] **Step 4:** `pnpm generate:plugin-schemas`, then `pnpm tc`, then the tests pass.
- [ ] **Step 5:** `pnpm check:changed`. Expected: clean.
- [ ] **Step 6:** Manual: `pnpm dev`, then run Claude Code in an Orca terminal and trigger `AskUserQuestion`. The dev-loaded Rich Presence plugin's raw event log (`orca plugin logs`) shows `prompt: "question"`. Capture this for Visual Proof (a terminal log screenshot).
- [ ] **Step 7:** Commit `feat(plugins): tell plugins when an agent is asking a question`.

### Task B2. Open PR 1

- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (or document any part left to CI).
- [ ] Push `feat/plugin-agent-prompt-kind` to `origin`.
- [ ] **Ask the author**, then `gh pr create -R stablyai/orca --base main --head jondmarien:feat/plugin-agent-prompt-kind` with the filled template and `Fixes #38340`.
- [ ] `gh pr checks <n> -R stablyai/orca --watch`. Fix and re-push on failure, running `pnpm check:changed` first.
- [ ] Then close #19023 (Task D1).

### Task B3. Plugin: question state (plugin repo, 1.1.0)

**Files:**
- `src/presence/agents.ts` (carry `prompt`)
- `src/presence/agent-state.ts`, `activity.ts`, `timeline.ts`, `panel-snapshot.ts`
- `src/panel/*`
- README

Rules:
- Display state `question`, used when `prompt === 'question'`, ranked between blocked and waiting.
- Discord small key `question`; panel icon `orca-question.png`; a colour picked from your question art (sample it from `assets/question.png`).
- Legend entry.
- Active only when the field is present. Older Orca is unaffected.

Tests: a row with `prompt` shows the question state everywhere; without it, waiting is unchanged.

Version 1.1.0 is tagged after PR 1 merges upstream. Until then it ships behind detection and is harmless.

## Part C. PR 2: UI focus (#38341)

Planned in detail when PR 1 is in review, following the same shape as Part B:
- capability, method, event, projection with privacy reducers
- generated docs
- tests for the reducers and consent
- a manual capture

The logic (not the code) comes from `archive/2026-09-pr-19023` (`plugin-ui-focus.ts`, `plugin-focused-surface.ts`).

## Part D. Housekeeping

### Task D1. Supersede #19023, after PR 1 is up

- [ ] **Ask the author**, then comment on #19023: "Superseded by smaller proposals: #38340 (PR #<n>), #38341, #38342, #38343. Panel settings/storage and richer readContext landed upstream separately." Then close it. Leave its branch untouched.

### Task D2. PRs 3 and 4 (#38342, #38343)

- [ ] Watch the issues. Plan the PRs only after a maintainer replies on the design questions. Until then, no code.
