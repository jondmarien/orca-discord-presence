# Handoff: continue on another machine

Last updated 2026-11-04 by the Linux session (Claude Code, Opus 5.5).

Open a new Claude Code session in a clone of this repo and say: **"Read docs/superpowers/HANDOFF.md and continue."** Everything needed is in this file, the specs and plans in `docs/superpowers/`, and the GitHub repos.

## Machine rule (important)

**Never run upstream Orca's full checks on the 16 GB Linux laptop.** That means `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm check:changed`, `pnpm build`, and the husky pre-commit hook. They froze it on 2026-11-04. Do Orca-repo work on the Windows desktop (about 100 GB RAM). The plugin repo (Bun, around 300 tests) is fine on either machine.

## Where things stand

**Plugin (`jondmarien/orca-discord-presence`)**
- `v1.0.1` is tagged on `main` (`0c79d11`). The onorca.dev listing was held for maintainer review ("size"). 1.0.1 shrinks the images to clear that; recheck https://www.onorca.dev/plugins/jondmarien/orca-discord-presence.
- Branch `jondmarien/minimal-shot` (a new Minimal-view listing screenshot) is **held for 1.1.0**. Don't tag it alone.
- 1.1.0 is the question state, once upstream #38340 lands (plan Task B3).

**Fork (`jondmarien/orca`)**
- Archive tags `archive/2026-09-{main,develop,pr-19023}` are pushed. `main` and `develop` are reset to upstream. `feat/plugin-host-presence-apis` (#19023's branch) is untouched.

**Upstream issues filed:** stablyai/orca #38340 (prompt kind), #38341 (UI focus), #38342 (panels in paired clients), #38343 (client relay).

**Upstream PR 1 (#38340): in progress, unverified**
- The worker's diff is saved as `handoff/38340-prompt-kind-wip.patch`, against upstream commit `308b500050`. It is about 16 files, +186/−35: a new `src/shared/plugins/events/plugin-agent-prompt-kind.ts`, the projection changes, the host-API spec, and the regenerated docs and types.
- None of it has been type-checked, tested or reviewed.
- The patch is in this branch at `handoff/38340-prompt-kind-wip.patch` (base commit in `handoff/38340-base.txt`). **Delete `handoff/` before merging this branch to main.**

## Next steps (Windows desktop)

1. Clone `jondmarien/orca`, add the `upstream` remote, then `git switch -c feat/plugin-agent-prompt-kind upstream/main`.
   - If the patch doesn't apply cleanly on the newest `main`, check out `308b500050` first, apply it, then rebase.
   - Use Node 24 and `corepack pnpm install`, plus `corepack pnpm -C mobile install --frozen-lockfile`.
2. Apply the patch and review it against `docs/superpowers/plans/2026-11-04-fork-rebuild-and-upstream-prs.md`, Task B1, and against upstream's rules in spec §2.
3. Run the targeted tests, `pnpm tc`, then `pnpm check:changed`, all on Windows.
4. Manual capture: run `pnpm dev`, dev-load the plugin, trigger an `AskUserQuestion`, and confirm `prompt: "question"` in `orca plugin logs`.
5. Commit `feat(plugins): tell plugins when an agent is asking a question`, push to the fork, and open the PR against stablyai/orca with the full template:
   - `Fixes #38340`
   - Author X handle `@nuclearsmilz`
   - the AI disclosure
6. Close #19023 with a comment that links the new issues and the PR (plan Task D1).

## Subagent rule

Workers are Orca orchestration **terminal** agents (Claude Sonnet 5.5), launched with `orca terminal create … --command "claude --model claude-sonnet-5-5 …"`. **Tell the user before** any worker runs heavy commands, and say which machine they will run on.
