# Fork rebuild + upstream Orca PRs: design

- **Date:** 2026-11-04 · **Status:** Approved 2026-11-04. Issues filed: stablyai/orca#38340 (prompt kind), #38341 (UI focus), #38342 (panels in paired clients), #38343 (client relay)
- **Supersedes:** §5–§7 of `2026-11-04-stock-orca-and-upstream-apis-design.md`. That spec's §6.1–§6.3 API designs still hold except where this one changes them.
- **Context:** plugin v1.0.0 shipped on stock Orca and is in onorca.dev review. This is the post-1.0 work. Remote presence through an Orca bridge or account system is **deferred to a later version** and is out of scope here.

## 1. Intent

Move the host APIs the plugin still lacks into stock Orca, as small PRs a maintainer can review quickly. The fork `jondmarien/orca` exists only to develop and dogfood those PRs before they land. Once each lands upstream, the plugin drops its fork-only paths.

## 2. How upstream wants contributions (researched 2026-11-04, `stablyai/orca` @ `274b9991`)

Sources: `.github/CONTRIBUTING.md`, `AGENTS.md`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `docs/agents-md-refs/*`, and merged PR history.

**Issues and PRs**
- Every outside PR **must link a real issue** with `Fixes #N`. Without one it is ignored, and "Refs" is not enough. Issues use the Feature request form: Problem / use case, Proposed solution, Alternatives.
- PRs follow the template:
  - ELI5
  - What Changed (before/after plus the mechanism)
  - Why (including alternatives considered)
  - Linked Issue
  - Visual Proof: before/after for behavior changes, or exactly `N/A` with a reason
  - Testing: platforms actually tested, plus the three checkboxes
  - Risk: level, the riskiest part, how to back it out
  - AI Disclosure
  - Review summary covering cross-platform, SSH/remote, agent, performance, UI and security
  - Agent-skill boundary checkbox
  - Author X handle
- PRs are **squash-merged**, and the PR title becomes the commit subject. Titles use `feat(plugins): …` / `fix(plugins): …`, or a plain sentence. Commits inside a PR are free-form, but keep them clean.
- Branch names describe the change: `feat/…`, `fix/…`, `chore/…`.
- Contributors **never bump the app version**; releases are maintainer-only. A new host method still declares `since` with the next host API minor, as maintainer PRs do.

**Checks.** Before every push, after the last edit or rebase, run `pnpm check:changed`, and never use `--no-verify`. CI runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`; those must pass locally too. Use `pnpm tc` for fast typechecks and `pnpm test:changed`. Watch CI with `gh pr checks --watch`; do not poll.

**Code rules**
- **Low test count.** Add a test only if it fails when the change is reverted, hard-codes the expected values, and runs at the single layer that owns the behavior. Never test copy, translations or CSS (see `docs/agents-md-refs/test-antipatterns.md`).
- **Minimal comments:** one line, explaining why, only when the code cannot say it.
- **Concrete file names.** No `helpers`, `utils` or `common`.
- **Reuse** existing logic before writing parallel versions.
- `.ts` over `.d.ts` for project types.

**First-class concerns for every change**
1. macOS / Linux / Windows
2. Remote hosts (SSH, paired servers)
3. Mobile
4. Folder workspaces (not every workspace is a git worktree)

**Plugin host API specifics**
- "Host API 1 is frozen": within `pluginApi` 1 things only grow. A new method gets `since` = the next minor (today 1.3, so new work targets **1.4**).
- `orca.host.has` lets plugins feature-detect.
- Docs are generated with `pnpm generate:plugin-schemas`.
- A host-API PR touches, as in the maintainer's own statusBar PR #37291:
  - `src/shared/plugins/workers/plugin-host-api*.ts` (method spec)
  - `src/main/plugins/workers/plugin-host-*-method-bindings.ts` and `plugin-service-host-call.ts`
  - `src/preload/api/plugin-host-api.ts`
  - `resources/plugins/types/orca-host.d.ts` (types written by `orca plugin types`)
  - `resources/plugins/declarative/orca-testing.mjs` (test kit)
  - `skill-guides/orca-plugin-authoring/references/*`
  - generated `docs/reference/*` and `docs/schemas/plugins/*`
  - `en.json` for consent and capability strings

**Who reviews.** Nearly all plugin-platform work so far is by the maintainer (nwparker). Outside plugin PRs that merged were small fixes. Our earlier #19023 (a large bundle) got no review in five weeks. So: **issue first, small PRs, and one concern per PR.**

## 3. Goals, non-goals, anti-goals

**Goals**
1. The fork `main` becomes upstream `main` plus our feature branches, each kept rebased and PR-ready.
2. One upstream issue and one PR per host API, in the order of §5.
3. Each PR passes `pnpm check:changed` and CI, and follows the template exactly.
4. The plugin feature-detects every new API with `orca.host.has`. Stock Orca keeps working with no change.

**Non-goals:** Orca bridge or account-based remote presence (later version); any app version bump; re-proposing APIs upstream already has.

**Anti-goals**
- A bundled mega-PR, as #19023 was.
- Discord-specific code in Orca core.
- New consent prompts for data plugins already get.
- Tests that upstream would call low-value.
- Losing the old fork work: archive tags come first.

## 4. Fork rebuild (`jondmarien/orca`)

1. **Archive.** Tag the current heads as `archive/2026-09-main`, `archive/2026-09-develop` and `archive/2026-09-pr-19023`, and push the tags. Do **not** touch `feat/plugin-host-presence-apis`, the branch behind #19023 (author's rule).
2. **Reset.** Force-push fork `main` to `stablyai/orca` `main`, and reset `develop` the same way or delete it. The author approved this on 2026-11-04.
3. **Local checkout.** Use `~/Projects/orca` (on `main` today). Add the `upstream` remote, run `pnpm install`, and confirm `pnpm dev` runs. `~/src/orca` can be removed later; that is the author's call.
4. **One feature branch per API**, each off `upstream/main`: `feat/plugin-agent-prompt-kind`, `feat/plugin-ui-focus`, `feat/plugin-client-relay`, `feat/plugin-panels-paired-clients`. Rebase each onto `upstream/main` before its PR.
5. **Dogfood.** Merge the branches into the fork's `main` (or an `integration` branch) so the plugin can run against all of them at once. Never open PRs from the integration branch.

## 5. Upstream PRs, in order

| # | API | Size | Why this order |
| --- | --- | --- | --- |
| 1 | **Agent prompt kind** | small | Additive, privacy-safe, and a good first PR to build trust |
| 2 | **UI focus** (`ui:focus`) | medium | A new capability, but a contained one; old PR #5/#8 work is reused |
| 3 | **Host plugin panels in paired clients** | medium–large | Lets Windows show the Linux plugin's panel. Needs maintainer design input |
| 4 | **Client relay** | large | Cross-machine and plugin-to-plugin. Most design risk; issue and discussion before code |

Each step: open the issue, wait briefly for signal (PRs 1–2 can go up right behind their issue; PRs 3–4 wait for a maintainer reply), then the PR, then CI green, then the review loop.

### 5.1 Agent prompt kind

Problem: plugins only see `working | blocked | waiting | done`. A pending question (`AskUserQuestion`) looks the same as any other wait.

API:
- Optional `prompt?: 'question' | 'permission'` on the `agent.status.changed` payload and on each `agents.list` row.
- Present only while that prompt is pending. Never carries the text, the options or the tool input.
- `since: 1.4`. Gated by the existing `agent:read` capability.

Source of truth: the agent-status entry's `interactivePrompt` (question). Use the existing permission-request signal for `permission`; confirm which field carries it.

Main touchpoints:
- `src/main/plugins/plugin-agent-status-event.ts` (`projectPluginAgentStatusChangedPayload`)
- the `agents.list` projection
- shared payload schemas

### 5.2 UI focus

As in the old spec §6.1:
- capability `ui:focus` (opt-in, re-prompts)
- method `ui.readFocus` (worker and panel)
- event `ui.focus.changed`
- `focusedSurface { kind, title, workspaceId?, agentId? }`, with titles reduced to a basename or hostname and capped at 80 bytes, path-bearing ids replaced by session-scoped opaque tokens, and `null` when unfocused
- `since: 1.4` or the next free minor
- No `readContext` change

Reuse the logic, not the code, from fork PRs #5/#8 at `archive/2026-09-pr-19023`.

### 5.3 Host plugin panels in paired clients

Problem: a desktop paired to another Orca shows only its **own** installed plugins' panels. The plugin running on the host where the agents live has no panel on the machine the person is sitting at.

Direction:
- A paired desktop client can render the host's plugin panels in an isolated frame.
- `plugin.request` and `panels.post` are routed over the existing runtime RPC.
- The client's own copy is not needed.

This is design-heavy (trust, consent on which machine, frame origin). The issue proposes it and asks the maintainer for the preferred shape **before code**.

### 5.4 Client relay

As in the old spec §6.2:
- The worker on the host calls `relay.publish({ channel, op, payload ≤ 8 KiB })`.
- The paired desktop client delivers it to its own copy of the same plugin as a `relay.received` event.
- Capability-advertised, with no protocol bump.
- Orca core never touches Discord.

Issue and discussion first. It may be shaped by the maintainer's answer on 5.3.

## 6. Plugin follow-through

The plugin side is a separate small PR per API, released as **1.1.x**:
- **Prompt kind:** a `question` state. Discord `question` badge, panel colour and icon `orca-question.png` (art already in `assets/`), `state-question` mapping, and its place in the timeline priority.
- **Focus:** the focused surface shown in the panel and on Discord, opt-in.
- **Panels in paired clients:** no plugin change expected beyond testing.
- **Relay:** a third sink with the order local IPC → relay → companion, never dual-publishing.

Each feature activates only when `orca.host.has(...)` is true. Until upstream merges, it works on the fork.

## 7. Author decisions (2026-11-04)

1. **X handle:** `@nuclearsmilz`, in the PR Author section.
2. **Issues:** all four were opened at once, so the maintainer sees the roadmap (#38340–#38343).
3. **#19023:** close and supersede it **after** the first new PR is up.
4. **Prompt kind scope:** the issue proposes `prompt?: 'question'` only. `blocked` already covers permission prompts. The derivation reuses `src/shared/agent-status/contracts/agent-pending-prompt.ts`.

## 8. Calls made by Claude (please check)

- PR order: prompt kind → focus → panels → relay.
- `~/Projects/orca` is the working checkout.
- Dogfood through an integration merge on fork `main`.
- Plugin follow-ups ship as 1.1.x, each with feature detection.
