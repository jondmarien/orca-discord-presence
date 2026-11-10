# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome.

## Before you start

- Search [open issues](https://github.com/jondmarien/orca-discord-presence/issues) first.
- For a bug, open an issue with the bug report form. Include your plugin version, OS, Discord client and the relevant lines from `plugin.log`.
- For a larger change or a new feature, open an issue first so we can agree on the approach. Some features wait on Orca APIs; see [ROADMAP.md](ROADMAP.md).

## Setup

You need [Bun](https://bun.sh) and, for a manual check, the Orca desktop app (`>=1.4.248`) with Discord desktop running.

```bash
bun install
bun test
bun run typecheck
bun run build
```

The tests use a fake Discord IPC server, so Discord does not need to be running for them.

## Project layout

| Path | What |
|---|---|
| `src/main.ts` | Plugin worker entry: Orca events, commands, panel handlers |
| `src/discord/` | Discord IPC client, socket discovery, client detection |
| `src/presence/` | Controller, activity builder, privacy gate, settings, status bar, logging |
| `src/panel/` | Panel source; `bun run build:panel` inlines it into `panel/index.html` |
| `companion/` | Optional companion app for remote presence |
| `scripts/` | Panel build and `discord-probe.mjs` |
| `test/` | Bun tests |
| `dist/main.js` | Built worker, committed so Git installs need no build |

[docs/architecture.md](docs/architecture.md) explains the process model, IPC, debounce and panel.

## Making a change

1. Branch from `main`.
2. Add a test for any new logic. For Discord connection code, use the fake-pipe helpers in `test/discord-client.test.ts`.
3. Run `bun test`, `bun run typecheck` and `bun run build`.
4. Commit the rebuilt `dist/main.js` and `panel/index.html` along with your source changes.
5. Use [Conventional Commits](https://www.conventionalcommits.org/) messages, for example `fix: ...`, `feat: ...` or `docs: ...`.
6. Add a line under an `Unreleased` heading in [CHANGELOG.md](CHANGELOG.md).
7. Open a pull request and fill in the template.

Do not bump the version. The maintainer does that at release time.

## Privacy

This plugin sends data to Discord, so privacy rules are strict. [docs/privacy.md](docs/privacy.md) lists what may be sent and what never is. Never send or log tokens, file paths or private names beyond what that document allows. Logs redact token-like keys; keep it that way.

## Testing in Orca

1. Enable **Settings → Plugins → Plugin system** in Orca.
2. Install your local build. `orca plugin validate` checks the manifest.
3. Turn on debug logging in the plugin settings and run **Rich Presence: Show Status** to find `plugin.log`.
4. If Discord does not show presence, run `bun scripts/discord-probe.mjs` to check each IPC socket.

## Releases (maintainer)

1. Bump the version in `package.json`, `orca-plugin.json`, `src/version.ts` and the README badge, then rebuild.
2. Move the `Unreleased` changelog entries under the new version.
3. Merge to `main`, then tag the merge commit `vX.Y.Z`. The `release.yml` workflow checks that the versions match and creates the GitHub Release. onorca.dev picks up the new tag on its own.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
