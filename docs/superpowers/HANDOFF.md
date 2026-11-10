# Handoff: Windows SET_ACTIVITY timeouts (v1.0.2)

Written 2026-11-09 by the Linux session (Claude Code, Opus 5.5). Branch: `jondmarien/windows-rpc-timeout`, from `main` at `f0ac386` (v1.0.2).

Open Claude Code in a clone of this repo on the **Windows** machine, `git switch jondmarien/windows-rpc-timeout`, and say: **"Read docs/superpowers/HANDOFF.md and continue."** Delete this file before merging to main.

## Rules

- Plugin repo only (Bun). `bun test`, `bun run typecheck` and `bun run build` are fine. Never run upstream Orca checks.
- Use the superpowers systematic-debugging skill: find the root cause before you fix anything.
- Ask the user before you push, open a PR or tag. The release is `v1.0.3`; tag it on the merge commit and the `release.yml` workflow does the rest. onorca.dev lists the new tag by itself within about an hour.
- Write to the user in plain language, with no customer data in output.

## Symptom (user report, Windows, v1.0.2 from the marketplace)

- The panel shows **"Connected · local"** with "Sending to: Local · Discord client #1 · IPC", but the Discord card says "Waiting for first update", and nothing appears on the Discord profile.
- Panel **Refresh** fails with: `Refresh failed: [plugin:jondmarien.discord-presence] presence.refresh timed out after 5000ms`.
- Plugin log (`%TEMP%\jondmarien-discord-presence\plugin.log`):

```
info activate version=1.0.2 debug=true ... bridge=false
info discord.connect_ok
error discord.set_activity_failed reason="discord connection closed"
warn discord.client reason="connect attempt 1/3 failed: discord handshake timed out; retrying in 3000ms"
warn discord.client reason="connect attempt 2/3 failed: discord handshake timed out; retrying in 6000ms"
   (repeated several times)
error discord.connect_failed reason="discord handshake timed out"
info discord.connect_ok
error discord.set_activity_failed reason="discord SET_ACTIVITY timed out"
info discord.force_transmit
error discord.set_activity_failed reason="discord SET_ACTIVITY timed out"
   (every send after that times out)
```

1.0.1 worked on the same machine (it was install-tested on Windows). The user uninstalled 1.0.1 and installed 1.0.2 from the marketplace.

## What the Linux session established

- **No Discord-path code changed between v1.0.1 and v1.0.2**: `git log v1.0.1..v1.0.2 -- src/discord` is empty. The only payload difference is `timestamps.start`, which is now the session start by default (`elapsedMode: 'session'`) instead of the agent-state start.
- **What changed in 1.0.2 around the worker:**
  - The plugin now has a status bar item, so Orca keeps the worker **resident** (never idle-reaped). It is started when the plugin is enabled.
  - Panel `presence.snapshot` can trigger `refresh()`.
  - The startup refresh passes `{ startup: true }`.
  - See `src/main.ts`.
- **The log pattern** is: the socket closes right after the first connect, then the `READY` handshake times out repeatedly, then after a reconnect every `SET_ACTIVITY` gets no reply.
  - A healthy pipe answers or `ERROR`s within milliseconds, so silence means the peer on the pipe is not answering.
  - Client: `src/discord/client.ts`. Command and handshake timeouts are 5 s each; replies are matched by `nonce`.
  - Windows pipe candidates are `\\?\pipe\discord-ipc-0..9` (`src/discord/ipc.ts`). "Auto" picks the first pipe that accepts (`src/discord/detect.ts`).
- **Second, confirmed bug:** the panel's `presence.refresh` waits on `syncAgentsFromList()`, `redetect(true)` (pipe scan) and `refresh({ force: true })`, which awaits `SET_ACTIVITY` with a 5 s timeout. The panel request timeout is also 5 s (`src/panel/panel.js`, `REQUEST_TIMEOUT_MS`), so a stalled Discord always surfaces as "Refresh failed".
- **Third, UX bug:** the panel's "Connected" means only that the handshake succeeded. It stays green while every send fails.

## Hypotheses to test (in order)

1. **Discord's RPC server is wedged on that machine** (a Discord-side issue). Test with the probe below. If the probe also times out, restart Discord fully (quit from the tray) and probe again.
2. **Another IPC client or a second Orca worker holds the pipe or the same app id.** Candidates: the 1.0.1 install still running after uninstall, a dev copy, or another Rich Presence tool such as arRPC, Vencord or a game launcher.
   - Check that `orca plugin list` shows exactly one discord-presence plugin.
   - Check Task Manager for another `node`/plugin-host process.
   - The 1.0.2 resident worker could also overlap with a reaped or old one during reinstall.
3. **"Auto" picked the wrong pipe**: `discord-ipc-0` belongs to a different program that accepts connections but does not speak Discord RPC properly. The probe prints every pipe. Compare which pipe answers properly with what the plugin connects to. Try the panel's Discord client dropdown.
4. **The payload is new in 1.0.2.** This is unlikely, because Discord replies `ERROR` to bad payloads rather than staying silent. To rule it out, set Elapsed timer counts to "Time in the current agent state" and see whether sends succeed.

## The probe

`scripts/discord-probe.mjs` (Node 18+). From the repo root, with Discord running:

```
node scripts/discord-probe.mjs
```

For each `discord-ipc-N` pipe that exists, it prints one JSON line: whether it connects, the `READY` time, whether `READY` included a user, and the `SET_ACTIVITY` reply time or `TIMEOUT` (10 s), plus the stage. It shows "IPC probe" on the profile for 3 s, then clears it. It uses the shipped app id `1545653843239374848`.

Run it:
- with Orca running, and again with Orca closed (this rules out the plugin worker holding the pipe);
- before and after a full Discord restart.

## Fixes to ship as v1.0.3 (once the root cause is known)

Fix the root cause first, with a failing test (`test/discord-client.test.ts` has a fake-pipe harness). Then:

1. **Refresh must not block the panel on Discord.**
   - `presence.refresh` should resync agents, rescan pipes, start the forced transmit without awaiting `SET_ACTIVITY`, and return the snapshot right away.
   - The panel picks up the result on the next `panels.post`.
   - Keep the 2 s rate limit.
   - Add a test that a stalled `setActivity` does not delay the handler's return.
2. **Honest connection state.**
   - Track the latest local send result in the controller, like `bridgeFailing` from v1.0.2: add `localFailing`, set on `set_activity_failed`, cleared on success.
   - The panel then shows "Connected · updates failing" in amber.
   - The status bar renderer (`src/presence/status-bar.ts`) treats it as not connected.
   - Add tests in `test/presence-controller.test.ts` and `test/presence-status-bar.test.ts`.
3. **Optional, if hypothesis 1 holds:** after N consecutive `SET_ACTIVITY` timeouts, close and reconnect the socket (it may land on a healthy pipe), and log it.
4. **Release:** bump to 1.0.3 in `package.json`, `orca-plugin.json`, `src/version.ts` and the README badge, rebuild `dist/`, and update ROADMAP if relevant. Delete `docs/superpowers/HANDOFF.md` and decide whether to keep `scripts/discord-probe.mjs` (it is useful as a support tool; if kept, mention it in the README troubleshooting section).

## Done means

- Root cause stated, with probe output as evidence.
- `bun test` (323+ tests), `bun run typecheck` and `bun run build` all pass.
- Manual check on Windows: presence shows on the Discord profile, panel Refresh never shows the 5000 ms error, and the panel shows the failing state when Discord does not answer.
- PR opened only after the user's OK.
