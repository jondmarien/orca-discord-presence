# Handoff: continue on another machine

Last updated 2026-11-05 by the Windows desktop session (Claude Code, Opus 5.5).

Open a new Claude Code session in a clone of this repo and say: **"Read docs/superpowers/HANDOFF.md and continue."** This file, the GitHub repos and the plan are enough to pick up the work.

The plan and its spec live on branch `origin/jondmarien/release-workflow`, not on `main`:
- `docs/superpowers/plans/2026-11-04-fork-rebuild-and-upstream-prs.md`
- `docs/superpowers/specs/2026-11-04-fork-rebuild-and-upstream-prs-design.md`

Read them with `git show origin/jondmarien/release-workflow:<path>`.

## Machine rules (important)

- **Linux laptop (16 GB):** never run upstream Orca's full checks there. That means `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm check:changed`, `pnpm build` and the husky pre-commit hook. They froze it on 2026-11-04.
- **Windows desktop (20 threads, about 100 GB RAM):** this is where Orca work happens.
  - The Orca clone is `J:\projects\personal-projects\orca`. Its `origin` is `jondmarien/orca` and its `upstream` is `stablyai/orca`.
  - Use Node 24: `fnm exec --using 24 -- corepack pnpm …`.
  - Run `check:changed` as `pnpm check:changed --base=upstream/main --maxWorkers=12`. Without `--base` it diffs against the fork's stale `origin/main`, checks 134 files instead of about 17, and froze the PC once.
  - The global `pnpm` shim (`J:\packages\pnpm\bin\.tools\pnpm\12.14.0`) is broken, so the husky hook fails. Before committing, run `corepack enable --install-directory $env:TEMP\corepack-shims pnpm` and put that directory first on `PATH`. Never use `--no-verify`.
  - Use the PowerShell tool, not Bash. The Bash PreToolUse hook breaks on backslash paths.
- **Upstream CI** covers the full test run. The user prefers that to long local runs: run targeted tests, `pnpm tc` and oxlint/oxfmt locally, and leave the rest to CI.
- **Tests that fail on unchanged `upstream/main` on Windows** (ignore them):
  - `src/main/plugins/hooks/plugin-agent-hook-sites.test.ts` ("agent.launch.before at the spawn")
  - `src/shared/plugins/authoring/plugin-host-typings.test.ts` ("type-check a frame script…", Windows paths)
  - The `vitest related` step of `check:changed`, with `EBUSY` on SQLite `-shm` files, worktree removal and Antigravity sign-in.
- **Upstream rules:** files are capped at 300 lines (`max-lines`), so split files instead of disabling the rule. Every added test must fail when the change is reverted.

## Where things stand

**Plugin (`jondmarien/orca-discord-presence`)**
- `v1.0.1` is tagged on `main` (`0c79d11`). The onorca.dev listing was held for maintainer review ("size"); 1.0.1 shrinks the images. Recheck https://www.onorca.dev/plugins/jondmarien/orca-discord-presence.
- Branch `jondmarien/minimal-shot` (a new Minimal-view listing screenshot, plus this handoff) is **held for 1.1.0**. Don't tag it alone.
- 1.1.0 is the question state (plan Task B3). Build it once upstream PR 1 merges.

**Fork (`jondmarien/orca`)**
- Archive tags `archive/2026-09-{main,develop,pr-19023}` are pushed. `main` and `develop` were reset to upstream, but are now stale against it.
- Branches `feat/plugin-agent-prompt-kind` and `feat/plugin-ui-focus` back the two open PRs below.

**Upstream (`stablyai/orca`)**

| Issue | PR | State |
|---|---|---|
| #38340 agent prompt kind | [#38406](https://github.com/stablyai/orca/pull/38406) | Open, awaiting review and CI. Host API minor **4**. |
| #38341 UI focus (`ui:focus`) | [#38415](https://github.com/stablyai/orca/pull/38415) | Open, awaiting review and CI. Host API minor **5**. |
| #38342 host plugin panels in paired clients | none | **On hold, no code**: waiting for a maintainer to answer the design questions in the issue (plan Task D2). |
| #38343 host-to-client relay | none | **On hold, no code**: same as above. |
| #19023 (old bundled PR) | n/a | Closed with a "superseded by" comment (Task D1, done). |

**PR #38406 (prompt kind):**
- Adds optional `prompt: 'question'` to `agent.status.changed` and `agents.list` rows.
- The new helper is `readPluginPromptKind` in `src/shared/plugins/events/plugin-agent-prompt-kind.ts`. It reuses `hookRowAgentPhase` and `parseAskFromStatus`, and the exported `PromptRow` type.
- Adds `fieldsSince` to the method spec type.
- Visual Proof is `N/A`. The user will capture `orca plugin logs` showing `prompt: "question"` if a maintainer asks.

**PR #38415 (UI focus):**
- Adds capability `ui:focus` (`since` 1.4.250), method `ui.readFocus` and event `ui.focus.changed`.
- The value is `{ kind: terminal|agent|editor|browser, title, agentId? } | null`, computed in main from the workspace session plus Electron window focus. There is no new IPC.
  - Logic: `src/shared/plugins/events/plugin-focused-surface.ts`
  - Wiring: `src/main/plugins/plugin-ui-focus-binding.ts`
  - Watcher: `watchPluginUiFocus` in `plugin-runtime-binding.ts`
  - The method spec sits in `plugin-host-api-panel-methods.ts`, because `plugin-host-api.ts` is at the line cap.
- Deliberately left out, and explained in the PR: `workspaceId`, because it is path-bearing and wouldn't join if tokenised; a simulator kind; replay on subscribe.

**Version bumps:** if the maintainers merge #38415 before #38406, or renumber the minors, update both:
- the `since` / `fieldsSince` values
- the panel `hello` minor in `src/renderer/src/components/plugins/frames/plugin-frame-host.test.ts`
The PRs tell the maintainers they can sort this out themselves.

## Next steps

1. **Watch the PRs.** Run `gh pr checks <n> --repo stablyai/orca`, and read review comments with `gh pr view <n> --repo stablyai/orca --comments`. Fix CI failures and answer reviews on the matching fork branch, then push. Rebase on `upstream/main` if asked.
2. **Watch #38342 and #38343.** Once a maintainer answers the design questions, plan and build those PRs in the same style: one issue per PR, the full template, `Fixes #N`, author X handle `@nuclearsmilz` in backticks, and the AI disclosure.
3. **After #38406 merges:** do plugin Task B3 (the question state, 1.1.0) in this repo, using `minimal-shot`'s screenshot. Tag 1.1.0.
4. **After #38415 merges:** the plugin can use `ui.readFocus` and `ui.focus.changed` to show "editing in Orca" or "chatting with an agent". This isn't planned yet; brainstorm it with the user first.

## Subagent rule

Tell the user **before** any agent or worker runs heavy commands, and say which machine they will run on.
