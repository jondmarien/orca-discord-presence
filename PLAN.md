# Orca Discord Rich Presence Implementation Plan

> **Historical note (v0.2):** Track A source now lives in TypeScript under `src/discord/`, `src/presence/`, and `src/main.ts`. Bun is the package manager / test / build toolchain; Orca still loads Node-compatible ESM from `dist/main.js`. Paths below that mention `src/*.mjs` and `node --test` are the original v0.1 plan. Do not treat this file as the current layout.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Discord Rich Presence plugin for Orca that reflects workspace, branch, and agent state — first as a zero-dependency marketplace plugin using only the existing plugin host API (Track A, MVP), then as a richer plugin unlocked by additive core PRs to Orca's plugin API (Track B).

**Architecture:** Track A is a standalone Orca plugin — a single trusted Node worker (`main`) that talks to the local Discord desktop client over Discord's RPC-over-IPC socket using `node:net` and ~120 lines of hand-rolled framing. It reads workspace state via `workspace.readContext`, reacts to `agent.status.changed` / `worktree.created` / `worktree.removed`, debounces presence writes to Discord's rate limit, and persists per-field toggles through `settings.set`. Track B is a sequence of small, independently-mergeable PRs against the Orca repo that widen the plugin API projections (agent type, model, execution host, terminal shell, panel-callable settings) — each one additive within `pluginApi` major 1 — followed by plugin releases that consume them.

**Tech Stack:** Node ESM (`.mjs`, no bundler, no dependencies), `node:net`, `node:test` + `node:assert/strict` for the plugin; TypeScript + Zod + Vitest for the Orca core changes.

---

## Context You Need Before Starting

Read these before Task 1. They are the whole contract:

| File | Why |
|---|---|
| [src/shared/plugins/plugin-host-api.ts](../../../src/shared/plugins/plugin-host-api.ts) | The complete host API. 13 methods. Nothing else exists. |
| [src/shared/plugins/plugin-manifest.ts](../../../src/shared/plugins/plugin-manifest.ts) | Manifest schema, event name set, contribution limits. |
| [src/shared/plugins/plugin-capabilities.ts](../../../src/shared/plugins/plugin-capabilities.ts) | The 7 capability kinds and the consent copy shown to users. |
| [src/shared/plugins/plugin-events.ts](../../../src/shared/plugins/plugin-events.ts) | Event payload schemas. Note how narrow they are. |
| [src/main/plugins/plugin-host-runtime.ts](../../../src/main/plugins/plugin-host-runtime.ts) | The `orca` object your `activate()` receives. |
| [examples/plugins/hello-orca/main.mjs](../../../examples/plugins/hello-orca/main.mjs) | Working reference plugin. |
| [src/main/plugins/plugin-worker-manager.ts](../../../src/main/plugins/plugin-worker-manager.ts) | Idle reap. Read `reapIdle()` — it governs plugin lifetime. |
| [src/main/plugins/plugin-worker-env.ts](../../../src/main/plugins/plugin-worker-env.ts) | The scrubbed env your worker gets. `XDG_RUNTIME_DIR` is **not** in it. |

### Five facts that dictate the design

1. **The worker API is `export default function activate(orca)`.** Do not hand-roll `process.send` IPC — [plugin-host-runtime.ts:92-118](../../../src/main/plugins/plugin-host-runtime.ts) already provides `orca.commands.register`, `orca.events.on`, `orca.host.call`, `orca.log`. An optional `export function deactivate()` runs on shutdown.
2. **Manifest events wake a sleeping worker; dynamic subscriptions do not.** [plugin-event-delivery.ts:30-33](../../../src/main/plugins/plugin-event-delivery.ts) calls `workerController.ensure()` for manifest-declared events, but only `deliverEventIfRunning` for `events.subscribe` ones. Declare every event in `contributes.events`. Declaring any event also *requires* the `events:subscribe` capability ([validation:135](../../../src/shared/plugins/plugin-manifest-contribution-validation.ts)).
3. **Idle reap kills the worker after 5 minutes.** `PLUGIN_WORKER_IDLE_REAP_MS = 5 * 60_000`, swept every 60 s by [plugin-service-housekeeping.ts:20](../../../src/main/plugins/plugin-service-housekeeping.ts). The activity clock only advances on host calls, delivered events, and command invocations ([plugin-host-process.ts:219](../../../src/main/plugins/plugin-host-process.ts)). A worker holding an open socket with no host calls **will be reaped and its presence cleared**. The 90-second `workspace.readContext` heartbeat in Task 7 is not optional.
4. **`XDG_RUNTIME_DIR` is not in the worker env allowlist.** Discord's Linux socket normally lives there. Reconstruct `/run/user/${os.userInfo().uid}` (Task 2).
5. **Panels cannot persist settings.** `PLUGIN_PANEL_ACTIONS` is derived from `panel: true` specs — that's `workspace.readContext`, `terminal.sendText`, `notifications.show` only. `storage.*`, `settings.*`, and command invocation are not panel-callable. Track A therefore uses one command per toggle. Task B4 fixes this properly.

### Paths and identity

- **`$PLUGIN_ROOT`** = `J:/projects/orca-discord-presence` — a **new, separate git repository**, not part of the Orca repo. Every Track A path below is relative to it. If you put it somewhere else, substitute consistently.
- **`$ORCA`** = `J:/projects/cloned-projects/orca/.claude/worktrees/orca-discord-rich-presence-fb5d8c` — this worktree. Every Track B path is relative to it.
- Plugin identity: publisher `d-sports`, id `discord-presence`, qualified key **`d-sports.discord-presence`**. Do not use the `orca-` id prefix with a non-`stablyai` publisher — [plugin-marketplace.ts:9-10](../../../src/shared/plugins/plugin-marketplace.ts) reserves that shape for official listings.

### Prerequisites (human, before Task 1)

**One Discord application serves every user of the plugin.** The maintainer creates it once and commits its ID as the plugin's default; users do not create their own. This is how vscord and every other IDE presence plugin works, and it is forced here anyway: a marketplace install is content-hashed and immutable, the worker env allowlist strips custom environment variables, and panels cannot call `settings.set` — so in v0.1 there is no user-facing path to supply an ID. The ID is public data (it appears in every presence payload), not a secret, so committing it is correct.

- [ ] Create a Discord application at https://discord.com/developers/applications. Name it "Orca" — this string is what Discord renders as the game name, and it is global to the application, not per-user. Copy the **Application ID** (a snowflake, ~19 digits). This value gets committed as `DEFAULT_SETTINGS.applicationId` in Task 5.
- [ ] Under Rich Presence → Art Assets, upload five 512×512 PNGs with these exact keys: `orca` (large), `state-working`, `state-blocked`, `state-waiting`, `state-idle` (small). Asset propagation takes a few minutes.
- [ ] Have the Discord **desktop** client installed and running. Browser Discord has no IPC socket; presence will never work against it.

---

## File Structure

### Track A — `$PLUGIN_ROOT`

```
orca-plugin.json              manifest: identity, commands, events, capabilities
package.json                  dev-only: type=module, test script. Not read by Orca.
README.md                     install, settings, privacy disclosure
src/main.mjs                  activate(orca): wires commands, events, heartbeat
src/discord-ipc-path.mjs      pure: candidate socket paths per platform
src/discord-frame.mjs         pure: encode/decode of the 8-byte-header wire format
src/discord-client.mjs        stateful: connect, handshake, setActivity, reconnect
src/presence-settings.mjs     pure: defaults, normalize, detail-level gating
src/presence-activity.mjs     pure: (snapshot, settings) -> Discord activity object
src/presence-controller.mjs   stateful: snapshot cache, debounce, enable/disable
test/discord-ipc-path.test.mjs
test/discord-frame.test.mjs
test/discord-client.test.mjs      (fake IPC server over node:net)
test/presence-settings.test.mjs
test/presence-activity.test.mjs
test/presence-controller.test.mjs (fake clock + fake client)
```

Split rationale: everything pure is separated from everything stateful, so the majority of the logic tests with no sockets and no timers. `discord-client.mjs` is the only file that touches a socket; `presence-controller.mjs` is the only file that owns time.

Use `.mjs` **everywhere**. The worker imports your entry as a `file://` URL ([plugin-host-runtime.ts:82](../../../src/main/plugins/plugin-host-runtime.ts)); `.mjs` makes ESM resolution independent of whether `package.json` ships or is read.

### Track B — `$ORCA`

| Task | Files |
|---|---|
| B1 | `src/shared/plugins/plugin-events.ts`, `src/shared/plugins/plugin-events.test.ts` (new), `src/main/index.ts:2640-2646` |
| B2a | `src/shared/plugins/plugin-host-api.ts`, `src/main/plugins/plugin-host-method-bindings.ts`, `src/main/plugins/plugin-host-service-bindings.ts`, `src/main/runtime/orca-runtime.ts:16153`, `src/main/plugins/plugin-host-methods.test.ts` |
| B2b | daemon → runtime → projection shell plumbing (scoped in the task) |
| B4 | `src/shared/plugins/plugin-host-api.ts`, `src/shared/plugins/plugin-panel-bridge.ts`, `src/main/plugins/plugin-panel-controller.ts` |

---

# TRACK A — v0.1 MVP (marketplace, zero core changes)

## Task 1: Repository scaffold

**Files:**
- Create: `$PLUGIN_ROOT/package.json`
- Create: `$PLUGIN_ROOT/.gitignore`
- Create: `$PLUGIN_ROOT/orca-plugin.json`

- [ ] **Step 1: Initialize the repo**

```bash
mkdir -p /j/projects/orca-discord-presence/src /j/projects/orca-discord-presence/test && cd /j/projects/orca-discord-presence && git init
```

- [ ] **Step 2: Write `package.json`**

Dev-only. Orca never reads it; it exists so `node --test` and editors behave.

```json
{
  "name": "orca-discord-presence",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 4: Write `orca-plugin.json`**

Capabilities are deliberately minimal: no `secrets` (the Discord application ID is public — `settings:own` is the right home), no `terminal:send` (this plugin never writes to a terminal). Every capability you declare appears verbatim in the user's consent dialog via `PLUGIN_CAPABILITY_DESCRIPTIONS`.

```json
{
  "manifestVersion": 1,
  "id": "discord-presence",
  "publisher": "d-sports",
  "name": "Discord Rich Presence",
  "version": "0.1.0",
  "description": "Shows your current Orca workspace, branch, and agent state as Discord Rich Presence. Every field is opt-in.",
  "engines": { "orca": ">=1.4.0" },
  "pluginApi": 1,
  "main": "src/main.mjs",
  "contributes": {
    "commands": [
      { "id": "presence.toggle", "title": "Discord Presence: Enable/Disable" },
      { "id": "presence.status", "title": "Discord Presence: Show Status" },
      { "id": "presence.detail-level", "title": "Discord Presence: Cycle Detail Level" },
      { "id": "presence.toggle-branch", "title": "Discord Presence: Toggle Branch" },
      { "id": "presence.toggle-agent-state", "title": "Discord Presence: Toggle Agent State" },
      { "id": "presence.toggle-terminals", "title": "Discord Presence: Toggle Terminal Count" },
      { "id": "presence.toggle-machine", "title": "Discord Presence: Toggle Machine Name" },
      { "id": "presence.toggle-elapsed", "title": "Discord Presence: Toggle Elapsed Timer" }
    ],
    "events": [
      { "on": "agent.status.changed" },
      { "on": "worktree.created" },
      { "on": "worktree.removed" }
    ]
  },
  "capabilities": [
    { "kind": "workspace:read" },
    { "kind": "events:subscribe" },
    { "kind": "storage" },
    { "kind": "settings:own" },
    { "kind": "notifications:show" }
  ]
}
```

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore orca-plugin.json && git commit -m "chore: scaffold Orca Discord presence plugin"
```

---

## Task 2: Socket path discovery

Discord listens on up to ten sockets, `discord-ipc-0` through `discord-ipc-9`. Flatpak and Snap installs nest them one directory deeper. On Linux the natural prefix (`XDG_RUNTIME_DIR`) is stripped from the plugin worker's env, so `/run/user/<uid>` must be reconstructed.

**Files:**
- Create: `$PLUGIN_ROOT/src/discord-ipc-path.mjs`
- Test: `$PLUGIN_ROOT/test/discord-ipc-path.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discordIpcCandidates } from '../src/discord-ipc-path.mjs'

test('windows candidates are named pipes, ten per install', () => {
  const paths = discordIpcCandidates({ platform: 'win32', env: {}, uid: 1000 })
  assert.equal(paths.length, 10)
  assert.equal(paths[0], '\\\\?\\pipe\\discord-ipc-0')
  assert.equal(paths[9], '\\\\?\\pipe\\discord-ipc-9')
})

test('posix prefers TMPDIR when present', () => {
  const paths = discordIpcCandidates({
    platform: 'darwin',
    env: { TMPDIR: '/var/folders/ab/T/' },
    uid: 501
  })
  assert.ok(paths.includes('/var/folders/ab/T/discord-ipc-0'))
})

test('linux reconstructs the XDG runtime dir that the worker env strips', () => {
  const paths = discordIpcCandidates({ platform: 'linux', env: {}, uid: 1000 })
  assert.ok(paths.includes('/run/user/1000/discord-ipc-0'))
})

test('linux covers flatpak and snap nesting', () => {
  const paths = discordIpcCandidates({ platform: 'linux', env: {}, uid: 1000 })
  assert.ok(paths.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'))
  assert.ok(paths.includes('/run/user/1000/snap.discord/discord-ipc-0'))
})

test('an explicit XDG_RUNTIME_DIR wins over the reconstructed one', () => {
  const paths = discordIpcCandidates({
    platform: 'linux',
    env: { XDG_RUNTIME_DIR: '/custom/run' },
    uid: 1000
  })
  assert.equal(paths[0], '/custom/run/discord-ipc-0')
})

test('trailing separators do not produce doubled slashes', () => {
  const paths = discordIpcCandidates({ platform: 'linux', env: { TMPDIR: '/tmp/' }, uid: 1000 })
  assert.ok(paths.every((path) => !path.includes('//')))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /j/projects/orca-discord-presence && node --test test/discord-ipc-path.test.mjs`
Expected: FAIL — `Cannot find module '../src/discord-ipc-path.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// Candidate Discord IPC socket paths, most-likely first. Pure: platform, env,
// and uid are injected so the table is testable off-platform.

const SOCKET_INDEX_LIMIT = 10
// Flatpak and Snap sandbox Discord's runtime dir one level down.
const SANDBOX_SUBDIRS = ['', 'app/com.discordapp.Discord', 'snap.discord']

function trimTrailingSeparator(value) {
  return value.replace(/[\\/]+$/, '')
}

export function discordIpcCandidates({ platform, env, uid }) {
  if (platform === 'win32') {
    return Array.from(
      { length: SOCKET_INDEX_LIMIT },
      (_unused, index) => `\\\\?\\pipe\\discord-ipc-${index}`
    )
  }
  // Why: the plugin worker env allowlist drops XDG_RUNTIME_DIR, so the
  // conventional Linux location has to be rebuilt from the uid.
  const prefixes = [
    env.XDG_RUNTIME_DIR,
    typeof uid === 'number' ? `/run/user/${uid}` : undefined,
    env.TMPDIR,
    env.TMP,
    env.TEMP,
    '/tmp'
  ]
    .filter((prefix) => typeof prefix === 'string' && prefix.length > 0)
    .map(trimTrailingSeparator)

  const seen = new Set()
  const candidates = []
  for (const prefix of prefixes) {
    for (const subdir of SANDBOX_SUBDIRS) {
      const base = subdir ? `${prefix}/${subdir}` : prefix
      for (let index = 0; index < SOCKET_INDEX_LIMIT; index++) {
        const candidate = `${base}/discord-ipc-${index}`
        if (!seen.has(candidate)) {
          seen.add(candidate)
          candidates.push(candidate)
        }
      }
    }
  }
  return candidates
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/discord-ipc-path.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/discord-ipc-path.mjs test/discord-ipc-path.test.mjs && git commit -m "feat: discord ipc socket path discovery"
```

---

## Task 3: Wire frame codec

Discord's IPC framing: 4-byte little-endian opcode, 4-byte little-endian payload length, then UTF-8 JSON. Opcodes: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG. This has been stable since 2017 and is the reason a dependency is unnecessary.

**Files:**
- Create: `$PLUGIN_ROOT/src/discord-frame.mjs`
- Test: `$PLUGIN_ROOT/test/discord-frame.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPCODE, encodeFrame, createFrameDecoder } from '../src/discord-frame.mjs'

test('encodes opcode and byte length in little-endian header', () => {
  const frame = encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: '123' })
  const body = JSON.stringify({ v: 1, client_id: '123' })
  assert.equal(frame.readInt32LE(0), 0)
  assert.equal(frame.readInt32LE(4), Buffer.byteLength(body))
  assert.equal(frame.subarray(8).toString('utf8'), body)
})

test('length is byte length, not character length', () => {
  const frame = encodeFrame(OPCODE.FRAME, { state: 'héllo — ok' })
  const declared = frame.readInt32LE(4)
  assert.equal(declared, frame.length - 8)
  assert.notEqual(declared, JSON.stringify({ state: 'héllo — ok' }).length)
})

test('decoder reassembles a frame split across chunk boundaries', () => {
  const frames = []
  const decoder = createFrameDecoder((op, data) => frames.push({ op, data }))
  const whole = encodeFrame(OPCODE.FRAME, { cmd: 'DISPATCH', evt: 'READY' })
  decoder.push(whole.subarray(0, 3))
  decoder.push(whole.subarray(3, 10))
  decoder.push(whole.subarray(10))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].op, OPCODE.FRAME)
  assert.equal(frames[0].data.evt, 'READY')
})

test('decoder emits multiple frames arriving in one chunk', () => {
  const frames = []
  const decoder = createFrameDecoder((op, data) => frames.push({ op, data }))
  decoder.push(
    Buffer.concat([encodeFrame(OPCODE.PING, { n: 1 }), encodeFrame(OPCODE.PONG, { n: 2 })])
  )
  assert.deepEqual(
    frames.map((frame) => frame.op),
    [OPCODE.PING, OPCODE.PONG]
  )
})

test('malformed json surfaces as an error, not a throw', () => {
  const errors = []
  const decoder = createFrameDecoder(
    () => assert.fail('should not emit'),
    (error) => errors.push(error)
  )
  const header = Buffer.alloc(8)
  header.writeInt32LE(OPCODE.FRAME, 0)
  header.writeInt32LE(3, 4)
  decoder.push(Buffer.concat([header, Buffer.from('{ x', 'utf8')]))
  assert.equal(errors.length, 1)
})

test('an absurd declared length is rejected instead of buffering forever', () => {
  const errors = []
  const decoder = createFrameDecoder(
    () => assert.fail('should not emit'),
    (error) => errors.push(error)
  )
  const header = Buffer.alloc(8)
  header.writeInt32LE(OPCODE.FRAME, 0)
  header.writeInt32LE(64 * 1024 * 1024, 4)
  decoder.push(header)
  assert.equal(errors.length, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/discord-frame.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// Discord IPC wire format: [int32LE opcode][int32LE byteLength][utf8 JSON].

export const OPCODE = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 }

// Why: a hostile or desynced stream must not let us buffer unbounded memory.
const MAX_FRAME_BYTES = 1024 * 1024

export function encodeFrame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(8 + body.length)
  frame.writeInt32LE(opcode, 0)
  frame.writeInt32LE(body.length, 4)
  body.copy(frame, 8)
  return frame
}

export function createFrameDecoder(onFrame, onError = () => {}) {
  let buffered = Buffer.alloc(0)
  let broken = false
  return {
    push(chunk) {
      if (broken) {
        return
      }
      buffered = Buffer.concat([buffered, chunk])
      for (;;) {
        if (buffered.length < 8) {
          return
        }
        const opcode = buffered.readInt32LE(0)
        const length = buffered.readInt32LE(4)
        if (length < 0 || length > MAX_FRAME_BYTES) {
          broken = true
          onError(new Error(`discord frame length out of range: ${length}`))
          return
        }
        if (buffered.length < 8 + length) {
          return
        }
        const body = buffered.subarray(8, 8 + length)
        buffered = buffered.subarray(8 + length)
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch (error) {
          broken = true
          onError(error)
          return
        }
        onFrame(opcode, parsed)
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/discord-frame.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/discord-frame.mjs test/discord-frame.test.mjs && git commit -m "feat: discord ipc frame codec"
```

---

## Task 4: Discord client

Connects to the first socket that accepts, handshakes, and exposes `setActivity` / `clearActivity`. Discord not running is the **normal** case, not an error — it must degrade to silent retry.

**Files:**
- Create: `$PLUGIN_ROOT/src/discord-client.mjs`
- Test: `$PLUGIN_ROOT/test/discord-client.test.mjs`

- [ ] **Step 1: Write the failing test**

The fake server speaks the real protocol over a real socket, so this exercises framing, handshake, and command dispatch end to end without Discord.

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { OPCODE, encodeFrame, createFrameDecoder } from '../src/discord-frame.mjs'
import { createDiscordClient } from '../src/discord-client.mjs'

function fakeSocketPath() {
  if (process.platform === 'win32') {
    return `\\\\?\\pipe\\orca-presence-test-${process.pid}-${Math.floor(performance.now())}`
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-presence-'))
  return { path: path.join(dir, 'sock'), dir }
}

function startFakeDiscord(socketPath, { onCommand }) {
  const server = net.createServer((socket) => {
    const decoder = createFrameDecoder((opcode, data) => {
      if (opcode === OPCODE.HANDSHAKE) {
        socket.write(
          encodeFrame(OPCODE.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } })
        )
        return
      }
      if (opcode === OPCODE.PING) {
        socket.write(encodeFrame(OPCODE.PONG, data))
        return
      }
      if (opcode === OPCODE.FRAME) {
        onCommand(data)
        socket.write(encodeFrame(OPCODE.FRAME, { cmd: data.cmd, nonce: data.nonce, data: {} }))
      }
    })
    socket.on('data', (chunk) => decoder.push(chunk))
  })
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)))
}

test('connects, handshakes, and sends SET_ACTIVITY with a pid and nonce', async () => {
  const target = fakeSocketPath()
  const socketPath = typeof target === 'string' ? target : target.path
  const commands = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: (data) => commands.push(data)
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath]
  })

  await client.connect()
  await client.setActivity({ details: 'orca', state: 'working' })

  assert.equal(commands.length, 1)
  assert.equal(commands[0].cmd, 'SET_ACTIVITY')
  assert.equal(typeof commands[0].nonce, 'string')
  assert.equal(commands[0].args.pid, process.pid)
  assert.equal(commands[0].args.activity.details, 'orca')

  await client.close()
  server.close()
  if (typeof target !== 'string') {
    rmSync(target.dir, { recursive: true, force: true })
  }
})

test('connect rejects when no candidate socket accepts', async () => {
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => ['/nonexistent/orca-presence-missing-socket']
  })
  await assert.rejects(() => client.connect(), /no discord ipc socket/i)
})

test('clearActivity sends a null activity', async () => {
  const target = fakeSocketPath()
  const socketPath = typeof target === 'string' ? target : target.path
  const commands = []
  const server = await startFakeDiscord(socketPath, {
    onCommand: (data) => commands.push(data)
  })
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath]
  })
  await client.connect()
  await client.clearActivity()
  assert.equal(commands[0].args.activity, null)
  await client.close()
  server.close()
  if (typeof target !== 'string') {
    rmSync(target.dir, { recursive: true, force: true })
  }
})

test('a dropped socket marks the client disconnected and fires onClose once', async () => {
  const target = fakeSocketPath()
  const socketPath = typeof target === 'string' ? target : target.path
  const server = await startFakeDiscord(socketPath, { onCommand: () => {} })
  let closes = 0
  const client = createDiscordClient({
    clientId: '123456789012345678',
    candidates: () => [socketPath],
    onClose: () => {
      closes++
    }
  })
  await client.connect()
  server.close()
  client.destroySocketForTest()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(client.isConnected(), false)
  assert.equal(closes, 1)
  if (typeof target !== 'string') {
    rmSync(target.dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/discord-client.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
import net from 'node:net'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { OPCODE, encodeFrame, createFrameDecoder } from './discord-frame.mjs'
import { discordIpcCandidates } from './discord-ipc-path.mjs'

const HANDSHAKE_TIMEOUT_MS = 5_000
const COMMAND_TIMEOUT_MS = 5_000

function connectToFirstAvailable(candidates) {
  return new Promise((resolve, reject) => {
    let index = 0
    const attempt = () => {
      if (index >= candidates.length) {
        reject(new Error('no discord ipc socket accepted a connection'))
        return
      }
      const candidate = candidates[index++]
      const socket = net.createConnection(candidate)
      const onError = () => {
        socket.destroy()
        attempt()
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        resolve(socket)
      })
    }
    attempt()
  })
}

export function createDiscordClient({
  clientId,
  candidates = () =>
    discordIpcCandidates({
      platform: process.platform,
      env: process.env,
      uid: typeof os.userInfo === 'function' ? os.userInfo().uid : undefined
    }),
  onClose = () => {},
  log = () => {}
}) {
  let socket = null
  let connected = false
  let closeNotified = false
  const pending = new Map()
  let onReady = null

  function teardown() {
    connected = false
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('discord connection closed'))
    }
    pending.clear()
    if (socket) {
      socket.removeAllListeners()
      socket.destroy()
      socket = null
    }
    if (!closeNotified) {
      closeNotified = true
      onClose()
    }
  }

  function handleFrame(opcode, data) {
    if (opcode === OPCODE.PING) {
      socket?.write(encodeFrame(OPCODE.PONG, data))
      return
    }
    if (opcode === OPCODE.CLOSE) {
      log(`discord closed the connection: ${data?.message ?? 'no reason given'}`)
      teardown()
      return
    }
    if (opcode !== OPCODE.FRAME) {
      return
    }
    if (data?.evt === 'READY') {
      onReady?.()
      return
    }
    const entry = data?.nonce ? pending.get(data.nonce) : null
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    pending.delete(data.nonce)
    if (data.evt === 'ERROR') {
      entry.reject(new Error(data.data?.message ?? 'discord rejected the command'))
    } else {
      entry.resolve(data.data ?? null)
    }
  }

  async function connect() {
    if (connected) {
      return
    }
    closeNotified = false
    socket = await connectToFirstAvailable(candidates())
    const decoder = createFrameDecoder(handleFrame, (error) => {
      log(`discord frame error: ${error.message}`)
      teardown()
    })
    socket.on('data', (chunk) => decoder.push(chunk))
    socket.on('close', teardown)
    socket.on('error', (error) => {
      log(`discord socket error: ${error.message}`)
      teardown()
    })

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        teardown()
        reject(new Error('discord handshake timed out'))
      }, HANDSHAKE_TIMEOUT_MS)
      onReady = () => {
        clearTimeout(timer)
        onReady = null
        connected = true
        resolve()
      }
      socket.write(encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: clientId }))
    })
  }

  function command(cmd, args) {
    if (!connected || !socket) {
      return Promise.reject(new Error('not connected to discord'))
    }
    const nonce = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(nonce)
        reject(new Error(`discord ${cmd} timed out`))
      }, COMMAND_TIMEOUT_MS)
      pending.set(nonce, { resolve, reject, timer })
      socket.write(encodeFrame(OPCODE.FRAME, { cmd, args, nonce }))
    })
  }

  return {
    connect,
    isConnected: () => connected,
    setActivity: (activity) => command('SET_ACTIVITY', { pid: process.pid, activity }),
    clearActivity: () => command('SET_ACTIVITY', { pid: process.pid, activity: null }),
    async close() {
      if (socket && connected) {
        try {
          await command('SET_ACTIVITY', { pid: process.pid, activity: null })
        } catch {
          // Discord already gone; nothing to clear.
        }
      }
      teardown()
    },
    // Test seam: simulate an abrupt peer disappearance.
    destroySocketForTest: () => socket?.destroy()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/discord-client.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/discord-client.mjs test/discord-client.test.mjs && git commit -m "feat: discord ipc client with handshake and activity commands"
```

---

## Task 5: Settings model

Every field is off by default except the master switch and the agent state. Detail level gates the *whole* class of identifying information; individual toggles refine within it. Privacy is the default, not a mode.

**Files:**
- Create: `$PLUGIN_ROOT/src/presence-settings.mjs`
- Test: `$PLUGIN_ROOT/test/presence-settings.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  DETAIL_LEVELS,
  normalizeSettings,
  nextDetailLevel,
  toggleField
} from '../src/presence-settings.mjs'

test('defaults are privacy-preserving', () => {
  assert.equal(DEFAULT_SETTINGS.enabled, true)
  assert.equal(DEFAULT_SETTINGS.detailLevel, 'generic')
  assert.equal(DEFAULT_SETTINGS.showBranch, false)
  assert.equal(DEFAULT_SETTINGS.showMachine, false)
  assert.equal(DEFAULT_SETTINGS.showTerminals, false)
  assert.equal(DEFAULT_SETTINGS.showAgentState, true)
  assert.equal(DEFAULT_SETTINGS.showElapsed, true)
})

test('normalize fills gaps and drops unknown keys', () => {
  const settings = normalizeSettings({ showBranch: true, nonsense: 42 })
  assert.equal(settings.showBranch, true)
  assert.equal(settings.detailLevel, 'generic')
  assert.equal('nonsense' in settings, false)
})

test('normalize rejects a non-boolean toggle and falls back to the default', () => {
  assert.equal(normalizeSettings({ showBranch: 'yes' }).showBranch, false)
})

test('normalize rejects an unknown detail level', () => {
  assert.equal(normalizeSettings({ detailLevel: 'everything' }).detailLevel, 'generic')
})

test('the plugin ships a usable application id by default', () => {
  assert.match(DEFAULT_SETTINGS.applicationId, /^\d{17,20}$/)
})

test('an absent application id falls back to the shipped default', () => {
  assert.equal(normalizeSettings({}).applicationId, DEFAULT_SETTINGS.applicationId)
})

test('normalize accepts a plausible application id override and rejects junk', () => {
  assert.equal(
    normalizeSettings({ applicationId: '123456789012345678' }).applicationId,
    '123456789012345678'
  )
  assert.equal(
    normalizeSettings({ applicationId: 'not-a-snowflake' }).applicationId,
    DEFAULT_SETTINGS.applicationId
  )
})

test('detail level cycles in a fixed order and wraps', () => {
  assert.deepEqual(DETAIL_LEVELS, ['off', 'generic', 'workspace', 'full'])
  assert.equal(nextDetailLevel('generic'), 'workspace')
  assert.equal(nextDetailLevel('full'), 'off')
})

test('toggleField flips exactly one boolean', () => {
  const next = toggleField(DEFAULT_SETTINGS, 'showBranch')
  assert.equal(next.showBranch, true)
  assert.equal(next.showMachine, DEFAULT_SETTINGS.showMachine)
  assert.notEqual(next, DEFAULT_SETTINGS)
})

test('toggleField ignores a non-boolean field name', () => {
  assert.deepEqual(toggleField(DEFAULT_SETTINGS, 'detailLevel'), DEFAULT_SETTINGS)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/presence-settings.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// Settings are persisted through the host `settings.*` API, so anything read
// back may be stale, partial, or hand-edited. Normalize on every read.

export const DETAIL_LEVELS = ['off', 'generic', 'workspace', 'full']

// The plugin's own public Discord application id. Public by construction — it
// rides in every presence payload. Users do not supply their own.
const SHIPPED_APPLICATION_ID = '000000000000000000' // replace with the real id from Prerequisites

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  // 'generic' never transmits a repo, branch, or machine name.
  detailLevel: 'generic',
  applicationId: SHIPPED_APPLICATION_ID,
  machineLabel: null,
  showBranch: false,
  showAgentState: true,
  showTerminals: false,
  showMachine: false,
  showElapsed: true
})

const BOOLEAN_FIELDS = Object.keys(DEFAULT_SETTINGS).filter(
  (key) => typeof DEFAULT_SETTINGS[key] === 'boolean'
)

// Discord snowflakes are 17-20 digits today; accept that range and nothing else.
const APPLICATION_ID_RE = /^\d{17,20}$/

function normalizeLabel(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 64) : null
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const settings = { ...DEFAULT_SETTINGS }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof source[field] === 'boolean') {
      settings[field] = source[field]
    }
  }
  if (DETAIL_LEVELS.includes(source.detailLevel)) {
    settings.detailLevel = source.detailLevel
  }
  // Why: absent or malformed overrides fall back to the shipped id — never to
  // null, which would leave the plugin permanently unable to connect.
  settings.applicationId =
    typeof source.applicationId === 'string' && APPLICATION_ID_RE.test(source.applicationId.trim())
      ? source.applicationId.trim()
      : DEFAULT_SETTINGS.applicationId
  settings.machineLabel = normalizeLabel(source.machineLabel) ?? DEFAULT_SETTINGS.machineLabel
  return settings
}

export function nextDetailLevel(current) {
  const index = DETAIL_LEVELS.indexOf(current)
  return DETAIL_LEVELS[(index + 1) % DETAIL_LEVELS.length]
}

export function toggleField(settings, field) {
  if (!BOOLEAN_FIELDS.includes(field)) {
    return settings
  }
  return { ...settings, [field]: !settings[field] }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/presence-settings.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/presence-settings.mjs test/presence-settings.test.mjs && git commit -m "feat: presence settings model with privacy-first defaults"
```

---

## Task 6: Activity builder

Pure function: `(snapshot, settings, now) -> activity | null`. This is where the privacy contract is actually enforced, so it gets the densest tests. Discord's activity limits: `details` and `state` are each capped at 128 characters, and `timestamps.start` is **Unix seconds** per the official RPC example.

Agent states come from Orca's fixed set — `working`, `blocked`, `waiting`, `done` ([agent-status-types.ts:16](../../../src/shared/agent-status-types.ts)). `done` renders as idle.

**Files:**
- Create: `$PLUGIN_ROOT/src/presence-activity.mjs`
- Test: `$PLUGIN_ROOT/test/presence-activity.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSettings } from '../src/presence-settings.mjs'
import { buildActivity } from '../src/presence-activity.mjs'

const SNAPSHOT = {
  displayName: 'acme-payments',
  branch: 'feat/refund-flow',
  terminalCount: 3,
  agentState: 'working',
  stateStartedAtMs: 1_700_000_000_000,
  machineName: 'jon-desktop'
}

const NOW_MS = 1_700_000_060_000

function settingsWith(overrides) {
  return normalizeSettings({ ...overrides })
}

test('detail level off produces no activity at all', () => {
  const activity = buildActivity(SNAPSHOT, settingsWith({ detailLevel: 'off' }), NOW_MS)
  assert.equal(activity, null)
})

test('disabled produces no activity even at full detail', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ enabled: false, detailLevel: 'full' }),
    NOW_MS
  )
  assert.equal(activity, null)
})

test('generic leaks no workspace, branch, or machine name', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'generic', showBranch: true, showMachine: true }),
    NOW_MS
  )
  const serialized = JSON.stringify(activity)
  assert.equal(activity.details, 'Working in Orca')
  assert.equal(serialized.includes('acme-payments'), false)
  assert.equal(serialized.includes('refund-flow'), false)
  assert.equal(serialized.includes('jon-desktop'), false)
})

test('workspace level shows the workspace name but never the branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'workspace', showBranch: true }),
    NOW_MS
  )
  assert.equal(activity.details, 'acme-payments')
  assert.equal(JSON.stringify(activity).includes('refund-flow'), false)
})

test('full level with showBranch renders workspace and branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showBranch: true }),
    NOW_MS
  )
  assert.equal(activity.details, 'acme-payments — feat/refund-flow')
})

test('full level without showBranch omits the branch', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showBranch: false }),
    NOW_MS
  )
  assert.equal(activity.details, 'acme-payments')
})

test('state combines agent state, terminals, and machine when enabled', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({
      detailLevel: 'full',
      showAgentState: true,
      showTerminals: true,
      showMachine: true
    }),
    NOW_MS
  )
  assert.equal(activity.state, 'working · 3 terminals · jon-desktop')
})

test('a single terminal is not pluralized', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, terminalCount: 1 },
    settingsWith({ detailLevel: 'full', showAgentState: false, showTerminals: true }),
    NOW_MS
  )
  assert.equal(activity.state, '1 terminal')
})

test('machineLabel overrides the detected machine name', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({
      detailLevel: 'full',
      showAgentState: false,
      showMachine: true,
      machineLabel: 'work-laptop'
    }),
    NOW_MS
  )
  assert.equal(activity.state, 'work-laptop')
})

test('agent state done renders as idle with the idle asset', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'done' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  assert.equal(activity.state, 'idle')
  assert.equal(activity.assets.small_image, 'state-idle')
})

test('an unrecognized agent state falls back to idle rather than leaking it', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, agentState: 'exfiltrating-secrets' },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  assert.equal(activity.state, 'idle')
  assert.equal(activity.assets.small_image, 'state-idle')
})

test('showElapsed emits unix seconds, not milliseconds', () => {
  const activity = buildActivity(SNAPSHOT, settingsWith({ detailLevel: 'full' }), NOW_MS)
  assert.equal(activity.timestamps.start, Math.floor(SNAPSHOT.stateStartedAtMs / 1000))
})

test('showElapsed disabled omits timestamps entirely', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({ detailLevel: 'full', showElapsed: false }),
    NOW_MS
  )
  assert.equal('timestamps' in activity, false)
})

test('a future start timestamp is clamped to now', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, stateStartedAtMs: NOW_MS + 60_000 },
    settingsWith({ detailLevel: 'full' }),
    NOW_MS
  )
  assert.equal(activity.timestamps.start, Math.floor(NOW_MS / 1000))
})

test('over-long names are truncated to discord limits', () => {
  const activity = buildActivity(
    { ...SNAPSHOT, displayName: 'x'.repeat(400) },
    settingsWith({ detailLevel: 'workspace' }),
    NOW_MS
  )
  assert.ok(activity.details.length <= 128)
})

test('an empty state string is omitted rather than sent blank', () => {
  const activity = buildActivity(
    SNAPSHOT,
    settingsWith({
      detailLevel: 'full',
      showAgentState: false,
      showTerminals: false,
      showMachine: false
    }),
    NOW_MS
  )
  assert.equal('state' in activity, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/presence-activity.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// The privacy boundary. Every identifying string must pass a detail-level gate
// here; nothing downstream re-checks.

const DISCORD_TEXT_MAX = 128

// Orca's agent states (AGENT_STATUS_STATES). Anything else is treated as idle
// so a future or malformed state can never be transmitted verbatim.
const AGENT_STATE_LABELS = {
  working: { label: 'working', asset: 'state-working' },
  blocked: { label: 'blocked', asset: 'state-blocked' },
  waiting: { label: 'waiting for input', asset: 'state-waiting' },
  done: { label: 'idle', asset: 'state-idle' }
}
const IDLE = AGENT_STATE_LABELS.done

function clamp(text) {
  return text.length > DISCORD_TEXT_MAX ? `${text.slice(0, DISCORD_TEXT_MAX - 1)}…` : text
}

function buildDetails(snapshot, settings) {
  if (settings.detailLevel === 'generic') {
    return 'Working in Orca'
  }
  const name = snapshot.displayName || 'Orca'
  if (settings.detailLevel === 'workspace' || !settings.showBranch || !snapshot.branch) {
    return name
  }
  return `${name} — ${snapshot.branch}`
}

function buildState(snapshot, settings) {
  const parts = []
  if (settings.showAgentState) {
    parts.push((AGENT_STATE_LABELS[snapshot.agentState] ?? IDLE).label)
  }
  if (settings.showTerminals && typeof snapshot.terminalCount === 'number') {
    parts.push(`${snapshot.terminalCount} terminal${snapshot.terminalCount === 1 ? '' : 's'}`)
  }
  // Machine identity is workspace-level information: never at 'generic'.
  if (settings.showMachine && settings.detailLevel !== 'generic') {
    const machine = settings.machineLabel ?? snapshot.machineName
    if (machine) {
      parts.push(machine)
    }
  }
  return parts.join(' · ')
}

export function buildActivity(snapshot, settings, nowMs) {
  if (!settings.enabled || settings.detailLevel === 'off') {
    return null
  }
  const activity = { details: clamp(buildDetails(snapshot, settings)) }
  const state = buildState(snapshot, settings)
  if (state) {
    activity.state = clamp(state)
  }
  if (settings.showElapsed && typeof snapshot.stateStartedAtMs === 'number') {
    // Discord's RPC example uses seconds; a clock skew forward would render a
    // nonsense countdown, so clamp to now.
    activity.timestamps = { start: Math.floor(Math.min(snapshot.stateStartedAtMs, nowMs) / 1000) }
  }
  const small = AGENT_STATE_LABELS[snapshot.agentState] ?? IDLE
  activity.assets = {
    large_image: 'orca',
    large_text: 'Orca',
    small_image: small.asset,
    small_text: small.label
  }
  return activity
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/presence-activity.test.mjs`
Expected: PASS, 16 tests

- [ ] **Step 5: Commit**

```bash
git add src/presence-activity.mjs test/presence-activity.test.mjs && git commit -m "feat: presence activity builder with detail-level privacy gates"
```

---

## Task 7: Presence controller

Owns the snapshot cache, the rate-limit debounce, reconnect backoff, and enable/disable. Time and the Discord client are both injected so this tests deterministically with no sleeping.

Rate limit: Discord throttles `SET_ACTIVITY`. Agent hooks fire many times per second during a tool-use run, so an undebounced controller gets throttled inside a single turn. One write per 15 s, always coalescing to the newest state.

**Files:**
- Create: `$PLUGIN_ROOT/src/presence-controller.mjs`
- Test: `$PLUGIN_ROOT/test/presence-controller.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPresenceController, MIN_UPDATE_INTERVAL_MS } from '../src/presence-controller.mjs'
import { DEFAULT_SETTINGS } from '../src/presence-settings.mjs'

function harness(overrides = {}) {
  let now = 1_000_000
  const activities = []
  const timers = []
  const client = {
    connected: false,
    connect: async () => {
      client.connected = true
    },
    isConnected: () => client.connected,
    setActivity: async (activity) => {
      activities.push(activity)
    },
    clearActivity: async () => {
      activities.push(null)
    },
    close: async () => {
      client.connected = false
    }
  }
  const controller = createPresenceController({
    client,
    settings: { ...DEFAULT_SETTINGS, detailLevel: 'full', ...overrides },
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      if (timer) {
        timer.cancelled = true
      }
    },
    log: () => {}
  })
  const advance = async (ms) => {
    now += ms
    for (const timer of [...timers]) {
      if (!timer.cancelled && timer.at <= now) {
        timer.cancelled = true
        await timer.fn()
      }
    }
  }
  return { controller, client, activities, advance, nowRef: () => now }
}

test('the first update writes through immediately', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  assert.equal(activities.length, 1)
  assert.equal(activities[0].details, 'repo')
})

test('a burst inside the rate-limit window collapses to one deferred write', async () => {
  const { controller, activities, advance } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.update({ displayName: 'repo', agentState: 'blocked', terminalCount: 1 })
  await controller.update({ displayName: 'repo', agentState: 'waiting', terminalCount: 1 })
  assert.equal(activities.length, 1)
  await advance(MIN_UPDATE_INTERVAL_MS)
  assert.equal(activities.length, 2)
  // Coalesced to the newest state, not replayed in order.
  assert.equal(activities[1].state, 'waiting for input')
})

test('an identical snapshot does not schedule a redundant write', async () => {
  const { controller, activities, advance } = harness()
  const snapshot = { displayName: 'repo', agentState: 'working', terminalCount: 1 }
  await controller.update(snapshot)
  await controller.update({ ...snapshot })
  await advance(MIN_UPDATE_INTERVAL_MS * 2)
  assert.equal(activities.length, 1)
})

test('disabling clears the presence exactly once', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.setSettings({ ...DEFAULT_SETTINGS, enabled: false })
  assert.equal(activities.at(-1), null)
  await controller.setSettings({ ...DEFAULT_SETTINGS, enabled: false })
  assert.equal(activities.filter((entry) => entry === null).length, 1)
})

test('detail level off clears the presence like disabling does', async () => {
  const { controller, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.setSettings({ ...DEFAULT_SETTINGS, detailLevel: 'off' })
  assert.equal(activities.at(-1), null)
})

test('a connect failure is swallowed and retried on the next update', async () => {
  const { controller, client, activities } = harness()
  let attempts = 0
  client.connect = async () => {
    attempts++
    if (attempts === 1) {
      throw new Error('no discord ipc socket accepted a connection')
    }
    client.connected = true
  }
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  assert.equal(activities.length, 0)
  await controller.update({ displayName: 'repo', agentState: 'blocked', terminalCount: 1 })
  assert.equal(activities.length, 1)
})

test('status reports connection state and the last transmitted activity', async () => {
  const { controller } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  const status = controller.status()
  assert.equal(status.connected, true)
  assert.equal(status.enabled, true)
  assert.equal(status.lastActivity.details, 'repo')
})

test('stop clears presence and closes the client', async () => {
  const { controller, client, activities } = harness()
  await controller.update({ displayName: 'repo', agentState: 'working', terminalCount: 1 })
  await controller.stop()
  assert.equal(activities.at(-1), null)
  assert.equal(client.isConnected(), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/presence-controller.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
import { buildActivity } from './presence-activity.mjs'

// Discord throttles SET_ACTIVITY. Agent hooks fire far faster than that during
// a tool-use run, so every write funnels through this window.
export const MIN_UPDATE_INTERVAL_MS = 15_000

export function createPresenceController({
  client,
  settings,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  log = () => {}
}) {
  let currentSettings = settings
  let snapshot = null
  let lastSentSerialized = null
  let lastActivity = null
  let lastSentAt = 0
  let pendingTimer = null
  let cleared = true

  async function ensureConnected() {
    if (client.isConnected()) {
      return true
    }
    try {
      await client.connect()
      return true
    } catch (error) {
      // Discord not running is the common case. Stay quiet; retry next update.
      log(`discord unavailable: ${error.message}`)
      return false
    }
  }

  async function transmit() {
    pendingTimer = null
    if (!snapshot) {
      return
    }
    const activity = buildActivity(snapshot, currentSettings, now())
    if (!activity) {
      await clearPresence()
      return
    }
    const serialized = JSON.stringify(activity)
    if (serialized === lastSentSerialized) {
      return
    }
    if (!(await ensureConnected())) {
      return
    }
    try {
      await client.setActivity(activity)
      lastSentSerialized = serialized
      lastActivity = activity
      lastSentAt = now()
      cleared = false
    } catch (error) {
      log(`failed to set activity: ${error.message}`)
      lastSentSerialized = null
    }
  }

  async function clearPresence() {
    if (cleared) {
      return
    }
    cleared = true
    lastSentSerialized = null
    lastActivity = null
    if (!client.isConnected()) {
      return
    }
    try {
      await client.clearActivity()
    } catch (error) {
      log(`failed to clear activity: ${error.message}`)
    }
  }

  async function schedule() {
    if (pendingTimer) {
      return
    }
    const elapsed = now() - lastSentAt
    if (elapsed >= MIN_UPDATE_INTERVAL_MS) {
      await transmit()
      return
    }
    pendingTimer = setTimer(() => {
      void transmit()
    }, MIN_UPDATE_INTERVAL_MS - elapsed)
  }

  return {
    async update(nextSnapshot) {
      snapshot = { ...snapshot, ...nextSnapshot }
      if (!currentSettings.enabled || currentSettings.detailLevel === 'off') {
        await clearPresence()
        return
      }
      // Cheap pre-check: skip scheduling when the rendered activity is
      // unchanged, so a chatty event stream costs nothing.
      const candidate = buildActivity(snapshot, currentSettings, now())
      if (candidate && JSON.stringify(candidate) === lastSentSerialized) {
        return
      }
      await schedule()
    },
    async setSettings(nextSettings) {
      currentSettings = nextSettings
      if (!currentSettings.enabled || currentSettings.detailLevel === 'off') {
        if (pendingTimer) {
          clearTimer(pendingTimer)
          pendingTimer = null
        }
        await clearPresence()
        return
      }
      // A settings change is user-initiated and rare: bypass the debounce.
      lastSentSerialized = null
      await transmit()
    },
    settings: () => currentSettings,
    status: () => ({
      enabled: currentSettings.enabled && currentSettings.detailLevel !== 'off',
      connected: client.isConnected(),
      detailLevel: currentSettings.detailLevel,
      lastActivity
    }),
    async stop() {
      if (pendingTimer) {
        clearTimer(pendingTimer)
        pendingTimer = null
      }
      await clearPresence()
      await client.close()
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/presence-controller.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Run the whole suite**

Run: `node --test test/`
Expected: PASS, 50 tests across 6 files

- [ ] **Step 6: Commit**

```bash
git add src/presence-controller.mjs test/presence-controller.test.mjs && git commit -m "feat: presence controller with rate-limit debounce and reconnect"
```

---

## Task 8: Worker entry

Wires everything to the `orca` API. Three things here are load-bearing and easy to get wrong:

- **The 90-second heartbeat.** `workspace.readContext` refreshes the worker's activity clock ([plugin-host-process.ts:219](../../../src/main/plugins/plugin-host-process.ts)) and catches branch switches, which emit no event. Without it the worker is reaped at 5 minutes and presence silently dies.
- **`.unref()` the interval.** An un-unrefed timer keeps the forked worker's event loop alive after shutdown.
- **`deactivate()` must clear presence.** Reap and quit both route through it.

**Files:**
- Create: `$PLUGIN_ROOT/src/main.mjs`

- [ ] **Step 1: Write the entry**

```javascript
import os from 'node:os'
import { createDiscordClient } from './discord-client.mjs'
import { createPresenceController } from './presence-controller.mjs'
import { normalizeSettings, nextDetailLevel, toggleField } from './presence-settings.mjs'

// Why: the worker is reaped after PLUGIN_WORKER_IDLE_REAP_MS (5 min) of no host
// calls. This poll both refreshes that clock and catches branch switches, which
// emit no event.
const HEARTBEAT_MS = 90_000

const TOGGLE_COMMANDS = {
  'presence.toggle-branch': 'showBranch',
  'presence.toggle-agent-state': 'showAgentState',
  'presence.toggle-terminals': 'showTerminals',
  'presence.toggle-machine': 'showMachine',
  'presence.toggle-elapsed': 'showElapsed'
}

let controller = null
let heartbeat = null

export default async function activate(orca) {
  const stored = await orca.host.call('settings.get').catch(() => ({ settings: {} }))
  let settings = normalizeSettings(stored?.settings)

  controller = createPresenceController({
    client: createDiscordClient({
      clientId: settings.applicationId,
      log: (message) => orca.log(message)
    }),
    settings,
    log: (message) => orca.log(message)
  })

  async function persist(nextSettings) {
    settings = nextSettings
    for (const [key, value] of Object.entries(nextSettings)) {
      await orca.host.call('settings.set', { key, value }).catch((error) => {
        orca.log(`failed to persist ${key}: ${error.message}`)
      })
    }
    await controller.setSettings(nextSettings)
  }

  async function refresh(agentState) {
    const context = await orca.host.call('workspace.readContext').catch(() => null)
    if (!context) {
      return
    }
    await controller.update({
      displayName: context.displayName,
      branch: context.branch,
      terminalCount: context.terminals.length,
      machineName: os.hostname(),
      ...(agentState
        ? { agentState: agentState.state, stateStartedAtMs: agentState.receivedAt }
        : {})
    })
  }

  orca.commands.register('presence.toggle', async () => {
    await persist({ ...settings, enabled: !settings.enabled })
    await refresh()
    return { enabled: settings.enabled }
  })

  orca.commands.register('presence.detail-level', async () => {
    await persist({ ...settings, detailLevel: nextDetailLevel(settings.detailLevel) })
    await refresh()
    return { detailLevel: settings.detailLevel }
  })

  for (const [commandId, field] of Object.entries(TOGGLE_COMMANDS)) {
    orca.commands.register(commandId, async () => {
      await persist(toggleField(settings, field))
      await refresh()
      return { [field]: settings[field] }
    })
  }

  orca.commands.register('presence.status', async () => {
    const status = controller.status()
    const summary = `enabled=${status.enabled} connected=${status.connected} detail=${status.detailLevel}`
    orca.log(`${summary} transmitting=${JSON.stringify(status.lastActivity)}`)
    await orca.host.call('notifications.show', {
      title: 'Discord Rich Presence',
      body: summary
    })
    return status
  })

  orca.events.on('agent.status.changed', async (payload) => {
    await refresh(payload)
  })
  orca.events.on('worktree.created', async () => {
    await refresh()
  })
  orca.events.on('worktree.removed', async () => {
    await refresh()
  })

  heartbeat = setInterval(() => {
    void refresh()
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  // Why: fire-and-forget. `activate` must resolve inside
  // PLUGIN_WORKER_READY_TIMEOUT_MS (10s) or the host SIGKILLs the worker, and
  // the first refresh chains into a socket scan plus a 5s handshake timeout.
  void refresh()
}

export async function deactivate() {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  await controller?.stop()
  controller = null
}
```

- [ ] **Step 2: Sanity-check that the module loads outside Orca**

Run: `node -e "import('./src/main.mjs').then((m) => console.log(typeof m.default, typeof m.deactivate))"`
Expected: `function function`

- [ ] **Step 3: Confirm the suite still passes**

Run: `node --test test/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main.mjs && git commit -m "feat: worker entry with heartbeat, commands, and event wiring"
```

**Note:** `settings.applicationId` is always populated — `normalizeSettings` falls back to the shipped id — so there is no "unconfigured" branch to handle. If the id is wrong, the failure surfaces as a handshake error in the log, not as a silent no-op.

---

## Task 9: Load in Orca as a dev plugin

There is no UI for `devPluginPaths`; it lives in Orca's persisted settings.

- [ ] **Step 1: Quit Orca completely**

- [ ] **Step 2: Edit the settings store**

Open `orca-data.json` in Orca's userData directory (Windows: `%APPDATA%/orca/orca-data.json`; macOS: `~/Library/Application Support/orca/orca-data.json`; Linux: `~/.config/orca/orca-data.json`). Path source: [persistence.ts:351](../../../src/main/persistence.ts). Both keys live inside the `settings` object and may already be present with default values — set them rather than assuming they're missing:

```json
"pluginSystemEnabled": true,
"devPluginPaths": ["J:/projects/orca-discord-presence"]
```

- [ ] **Step 3: Confirm the application id is committed**

`SHIPPED_APPLICATION_ID` in `src/presence-settings.mjs` must be the real snowflake from Prerequisites, not the `000000000000000000` placeholder. The settings test from Task 5 only checks the shape, so a placeholder passes tests and then fails the handshake at runtime with `discord handshake timed out`.

- [ ] **Step 4: Start Orca and approve the consent dialog**

Expected: a consent prompt naming the plugin, listing five capabilities in plain language, and disclosing that the plugin runs a trusted Node worker. Read it — this exact text is what your users see. If any line misrepresents the plugin, fix the manifest, not the dialog.

- [ ] **Step 5: Trigger activation**

Run the command "Discord Presence: Show Status" from the command palette. Expected: a desktop notification with `enabled=true connected=true detail=generic`, and your Discord profile showing "Orca — Working in Orca".

This command is also what forks the worker, and the first connect is fire-and-forget, so it can report `connected=false` on the very first run. Run it a second time before debugging anything.

- [ ] **Step 6: Check the plugin log if it did not connect**

Plugin logs go to the host's `PluginLogBuffer`; audit entries land in the plugins data dir's `audit.log`. Expected failure text if Discord is closed: `discord unavailable: no discord ipc socket accepted a connection`. That is the correct silent-degrade path, not a bug.

---

## Task 10: Verify idle-reap survival

The single most likely way this plugin breaks in the field.

- [ ] **Step 1: Get presence showing, then leave Orca completely idle for 7 minutes**

Do not touch a terminal, do not run an agent, do not switch worktrees.

- [ ] **Step 2: Confirm presence is still live in Discord after 7 minutes**

Expected: still showing. If it vanished at ~5 minutes, the heartbeat is broken. Check for `worker reaped after idle period` in the plugin log — that message means `lastActivityAt` was not being refreshed and the `HEARTBEAT_MS` interval is not firing (most likely cause: the interval was created before `activate` resolved, or `.unref()` was called on a timer that also needed to keep the loop alive — verify the interval callback actually invokes `orca.host.call`).

- [ ] **Step 3: Record the result in the README's verification section**

---

## Task 11: Cross-platform and reconnect verification

- [ ] **Step 1: Windows** — presence appears; socket resolves to `\\?\pipe\discord-ipc-0`.
- [ ] **Step 2: macOS** — presence appears; socket resolves under `$TMPDIR`.
- [ ] **Step 3: Linux** — presence appears. Test a native install first, then Flatpak if available. A native install with the env-stripped worker exercises the `/run/user/<uid>` reconstruction, which is the whole reason Task 2 exists.
- [ ] **Step 4: Reconnect** — with presence live, quit Discord entirely. Expected: no error dialog, no notification spam, one log line. Restart Discord, trigger any agent activity. Expected: presence returns within one heartbeat (≤90 s).
- [ ] **Step 5: Burst** — run an agent through a long tool-use turn. Expected: presence updates at most once per 15 s; no Discord rate-limit errors in the log.
- [ ] **Step 6: SSH workspace** — open a workspace on an SSH host. Expected: presence still reflects the workspace, but the machine name (if enabled) is your **local** machine, because the worker runs in desktop main. Confirm the README says exactly this.

---

## Task 12: README and privacy disclosure

**Files:**
- Create: `$PLUGIN_ROOT/README.md`

- [ ] **Step 1: Write it**

Must contain, at minimum:

1. **What is transmitted.** An explicit table: field → example value → which setting controls it → default. State plainly that workspace names, branch names, and machine names are sent to Discord's servers and rendered publicly on your profile, and that client repository names can identify clients.
2. **Setup.** For users: install, enable, done — the plugin ships its own Discord application ID and requires no Discord developer account. For maintainers: the application ID and the five asset keys, and that changing the ID means a new release. State explicitly that v0.1 has no user-facing override (v1.0 adds one with the settings panel).
3. **Settings.** Every command, what it does, the detail-level ladder (`off` → `generic` → `workspace` → `full`) and what each level permits.
4. **Known limits.** No file-level presence (Orca's host API v0 exposes none). Machine name is the Orca client machine, not an SSH host. Requires the Discord desktop client. Presence starts on the first agent event, worktree event, or command — not at app launch.
5. **Verification matrix** from Tasks 10–11.

- [ ] **Step 2: Commit and tag**

```bash
git add README.md && git commit -m "docs: readme with privacy disclosure and setup" && git tag v0.1.0
```

---

## Task 13: Publish to a marketplace

Orca installs plugins from git sources listed in an `orca-marketplace.json` index ([plugin-marketplace.ts](../../../src/shared/plugins/plugin-marketplace.ts)). Users add custom marketplace sources; the official one is `stablyai/orca-plugins`.

- [ ] **Step 1: Push the plugin repo to a public git remote and confirm the tag is pushed**

The marketplace entry pins a ref, and installs resolve it to an exact commit — an unpushed tag makes the listing irreproducible.

- [ ] **Step 2: Create the marketplace index repo**

A separate repo containing one file, `orca-marketplace.json`:

```json
{
  "name": "d-sports Orca plugins",
  "owner": "d-sports",
  "plugins": [
    {
      "id": "d-sports.discord-presence",
      "source": {
        "kind": "git",
        "url": "https://github.com/<your-org>/orca-discord-presence.git",
        "ref": "v0.1.0"
      },
      "description": "Discord Rich Presence for Orca workspaces and agent state.",
      "categories": ["integrations"]
    }
  ]
}
```

Constraints from the schema: `id` must be a valid qualified key and must match the manifest's `publisher.id` exactly; `url` must be HTTPS or SSH; `ref` is required; categories are lowercase slugs and must avoid the unsupported list (`themes`, `icons`, `icon-themes`, `terminal-themes`, `skills`) or the listing is hidden.

- [ ] **Step 3: Add the marketplace in Orca and install**

Add your index repo as a marketplace source, remove the `devPluginPaths` entry, restart, and install `d-sports.discord-presence` from the marketplace UI.

- [ ] **Step 4: Verify the installed copy**

Expected: the install is content-hashed and immutable; consent is requested again (the fingerprint covers capabilities plus worker trust); presence works identically to the dev-path install **with no further configuration**, because the application ID shipped inside the package. If this step needs any manual setup, the Prerequisites decision was not applied — go fix Task 5, not this step.

- [ ] **Step 5: Only after that works, propose it to the official index**

Open a PR against `stablyai/orca-plugins` adding the same entry. Track A is done.

---

# TRACK B — core PRs to Orca

Each task is a separate PR against `$ORCA`, mergeable alone, additive within `pluginApi` major 1. Do them in order — B1 is deliberately the smallest possible change so the pattern is established before anything larger.

Before any of these, read [docs/reference/remote-wire-compatibility.md](../../reference/remote-wire-compatibility.md). Clients and remote hosts update independently; a new optional field is safe, and changing what a host publishes reaches old clients even with no wire change.

## Task B1: Expose agent type and model on `agent.status.changed`

The runtime already holds both — `AgentStatusEntry.agentType` and `.model` ([agent-status-types.ts:99-101](../../../src/shared/agent-status-types.ts)) — and the emit site at [index.ts:2641](../../../src/main/index.ts) already has the enriched payload in hand. The plugin projection simply drops them.

**Files:**
- Modify: `src/shared/plugins/plugin-events.ts:28-33`
- Create: `src/shared/plugins/plugin-events.test.ts`
- Modify: `src/main/index.ts:2640-2646`

- [ ] **Step 1: Write the failing test**

Create `src/shared/plugins/plugin-events.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { agentStatusChangedPayloadSchema } from './plugin-events'

describe('agent.status.changed payload', () => {
  const base = {
    worktreeId: 'repo::/path',
    paneKey: 'tab:leaf',
    state: 'working',
    receivedAt: 1_700_000_000_000
  }

  it('accepts a payload with no agent identity (older hosts)', () => {
    expect(agentStatusChangedPayloadSchema.safeParse(base).success).toBe(true)
  })

  it('carries agentType and model when the host supplies them', () => {
    const parsed = agentStatusChangedPayloadSchema.parse({
      ...base,
      agentType: 'claude',
      model: 'claude-opus-5'
    })
    expect(parsed.agentType).toBe('claude')
    expect(parsed.model).toBe('claude-opus-5')
  })

  it('bounds agentType and model so a malicious hook cannot blow up a consumer', () => {
    const parsed = agentStatusChangedPayloadSchema.safeParse({
      ...base,
      agentType: 'x'.repeat(200)
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a non-string model', () => {
    expect(agentStatusChangedPayloadSchema.safeParse({ ...base, model: 42 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config config/vitest.config.ts src/shared/plugins/plugin-events.test.ts`
Expected: FAIL — the extra keys are stripped or the length bound is absent

- [ ] **Step 3: Extend the schema**

In `src/shared/plugins/plugin-events.ts`, add to `agentStatusChangedPayloadSchema`. Reuse the runtime's own bounds so the projection can never be looser than the source:

```typescript
  agentType: z.string().min(1).max(AGENT_TYPE_MAX_LENGTH).optional(),
  model: z.string().min(1).max(AGENT_MODEL_MAX_LENGTH).optional()
```

Import `AGENT_TYPE_MAX_LENGTH` and `AGENT_MODEL_MAX_LENGTH` from `../agent-status-types`.

- [ ] **Step 4: Populate at the emit site**

In `src/main/index.ts`, extend the `emitEvent('agent.status.changed', …)` call to pass `enriched.payload.agentType` and `enriched.payload.model`. Both are already optional on the payload type; pass them through conditionally so `undefined` never becomes an explicit key.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run --config config/vitest.config.ts src/shared/plugins/ src/main/plugins/`
Expected: PASS, including the existing conformance and host-method suites

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add src/shared/plugins/plugin-events.ts src/shared/plugins/plugin-events.test.ts src/main/index.ts && git commit -m "feat(plugins): expose agent type and model on agent.status.changed"
```

- [ ] **Step 8: Open the PR**

Frame it as a generic plugin-API enrichment, not a Discord feature. Note in the description: additive optional fields, no capability change, no consent-fingerprint change, older plugins unaffected, no new stream opcode.

---

## Task B2a: Expose the execution host on `workspace.readContext`

`Worktree.hostId` is an `ExecutionHostId` ([execution-host.ts:7](../../../src/shared/execution-host.ts)) — `local`, `ssh:<target>`, or `runtime:<env>`. Projecting a `{ kind, label }` pair answers "what machine am I on" correctly for SSH workspaces, which `os.hostname()` in the worker cannot.

**Files:**
- Modify: `src/shared/plugins/plugin-host-api.ts:26-43`
- Modify: `src/main/plugins/plugin-host-method-bindings.ts:11-15,72-91`
- Modify: `src/main/plugins/plugin-host-service-bindings.ts:9-14,38-50`
- Modify: `src/main/runtime/orca-runtime.ts:16153-16182`
- Modify: `src/main/plugins/plugin-host-methods.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/main/plugins/plugin-host-methods.test.ts`, add cases asserting that `workspace.readContext` returns `host: { kind: 'local' }` for a local worktree, `host: { kind: 'ssh', label: <target label> }` for an SSH one, and omits `host` entirely when the delegate supplies no `hostId`. Follow the existing fake-services pattern in that file rather than inventing a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/plugins/plugin-host-methods.test.ts`
Expected: FAIL — `host` is not in the result

- [ ] **Step 3: Extend the result schema**

In `plugin-host-api.ts`, add to `workspaceReadContextResult`:

```typescript
    host: z
      .object({
        kind: z.enum(['local', 'ssh', 'runtime']),
        label: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH).optional()
      })
      .strict()
      .optional()
```

Do **not** expose the raw `ExecutionHostId`. It embeds an encoded target id, which is exactly the class of internal identifier the existing comment at [plugin-host-method-bindings.ts:78](../../../src/main/plugins/plugin-host-method-bindings.ts) says to project out.

- [ ] **Step 4: Thread it through**

`orca-runtime.ts:resolveActiveWorktreeContext` returns `hostId`; `plugin-host-service-bindings.ts` parses it into `{ kind, label }` using the helpers in `src/shared/execution-host.ts`; the binding in `plugin-host-method-bindings.ts` passes the already-safe projection through.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `pnpm vitest run --config config/vitest.config.ts src/main/plugins/ src/shared/plugins/ && pnpm typecheck && pnpm lint`
Expected: PASS. The conformance suite ([plugin-host-conformance.test.ts](../../../src/main/plugins/plugin-host-conformance.test.ts)) must stay green — it guards the spec/binding contract.

- [ ] **Step 6: Commit and open the PR**

```bash
git commit -am "feat(plugins): project execution host kind and label into workspace.readContext"
```

Note in the PR: the label must be safe for a remote host to publish to an older client, and `host` is optional so a host that cannot resolve it simply omits the key.

---

## Task B2b: Expose the terminal shell (larger — scope before starting)

The shell is resolved at PTY spawn in the daemon ([pty-subprocess.ts:635](../../../src/main/daemon/pty-subprocess.ts)) and normalized for attribution in [terminal-attribution.ts:44](../../../src/main/attribution/terminal-attribution.ts). It is **not** on `RuntimeTerminalSummary` ([runtime-types.ts:439](../../../src/shared/runtime-types.ts)), so there is no existing path from the daemon to the plugin projection.

- [ ] **Step 1: Trace the full path before writing code**

Daemon PTY record → runtime session state → `RuntimeTerminalSummary` → `listWorktreeTerminals` → `workspace.readContext.terminals[]`. Write the trace down in the PR description; if any hop turns out to require a new daemon message, that is a separate PR that lands first.

- [ ] **Step 2: Decide what to publish**

Publish a normalized **shell family name** (`pwsh`, `bash`, `zsh`, `fish`, `cmd`, `wsl`), not a path. A full shell path leaks usernames and install layout, and [pty-owner-backend.ts](../../../src/shared/pty-owner-backend.ts) already derives a basename-based classification you can reuse instead of writing a second one.

- [ ] **Step 3: Add `shell?: string` to the terminal projection with tests at every hop, then commit per hop**

- [ ] **Step 4: Confirm SSH and WSL both report correctly, not just local**

---

## Task B3: Reasoning effort — deferred, with a written rationale

Effort is a session launch option ([agent-session-host-authority.ts:92](../../../src/shared/agent-session-host-authority.ts)) parsed from CLI flags like `--reasoning-effort` ([agent-session-option-catalog-claude-codex.ts](../../../src/shared/agent-session-option-catalog-claude-codex.ts)). It never enters the agent hook status stream, so no projection change can surface it — the data does not exist at the seam.

Exposing it means carrying session-option state into `AgentStatusEntry`, keeping it correct across mid-session `/effort` changes, and doing so for every agent that supports the concept. Agent CLI **version** is worse: Orca does not capture it anywhere.

- [ ] **Step 1: Write this up as a standalone proposal, not as part of the presence work**

- [ ] **Step 2: Do not block Track A or any of B1/B2 on it**

---

## Task B4: Make settings panel-callable, then ship a real settings UI

Eight commands where six should be one settings screen is the symptom; the cause is that `PLUGIN_PANEL_ACTIONS` excludes every persistence method, so no plugin can ship a settings screen. This is a platform gap, not a Discord one — frame the PR that way.

**Files:**
- Modify: `src/shared/plugins/plugin-host-api.ts` (the `panel` flags)
- Modify: `src/shared/plugins/plugin-panel-bridge.ts`
- Modify: `src/main/plugins/plugin-panel-controller.ts`
- Tests: `src/shared/plugins/plugin-panel-call-admission.test.ts`, `src/main/plugins/plugin-panel-controller.test.ts`

- [ ] **Step 1: Pick the approach and justify it in the PR**

Either (a) flip `panel: true` on `settings.get` / `settings.set` / `storage.*` — these are already scoped `plugin-private`, so a panel gains no access to anything outside its own plugin — or (b) add a `commands.invoke` panel action. (a) is the smaller change and the one the scope metadata already supports; (b) is more general but widens the panel surface considerably. Recommend (a).

- [ ] **Step 2: Write admission tests first**

A panel must be able to read and write its **own** plugin's settings and must not be able to reach another plugin's. The existing admission tests are the right place and the right pattern.

- [ ] **Step 3: Implement, run the panel suites, typecheck, lint, commit, open the PR**

---

## Track B follow-on plugin releases

Each ships only after its core PR is released in an Orca version you can name in `engines.orca`.

- [ ] **v0.2** — consume B1. Add `showAgent` and `showModel` settings (both default off, both gated to `full`). Extend the `state` line: `codex · gpt-5.1-codex · working`. Update `presence-activity.mjs` and its tests first; the controller and client need no changes.
- [ ] **v0.3** — consume B2a/B2b. Replace `os.hostname()` with the projected host, so SSH workspaces report the actual host. Add `showShell`. Update the README's "machine name is your local machine" limitation — it stops being true.
- [ ] **v1.0** — consume B4. Ship a settings panel with a field-level application-id override, delete the six field/detail toggle commands, keep `presence.toggle` and `presence.status`. Bump `engines.orca`.

---

## Risks

| Risk | Mitigation |
|---|---|
| Idle reap silently kills presence | Task 10 is a dedicated 7-minute verification. Heartbeat is 90 s, well inside the 5-minute window. |
| Discord rate-limits during an agent burst | 15 s debounce with coalescing, covered by controller tests. |
| Linux socket not found because `XDG_RUNTIME_DIR` is stripped | `/run/user/<uid>` reconstruction, plus Flatpak and Snap subdirs, covered by Task 2 tests. |
| Presence leaks a client repo name | Detail level defaults to `generic`; `presence.status` prints exactly what is transmitted; README discloses it. |
| A future Orca release changes the worker contract | `engines.orca` gates the minimum; the API is marked EXPERIMENTAL until `pluginApi` v1 freezes. Watch that freeze. |
| Track B PRs stall in review | Track A ships and works standalone. Nothing in Track A depends on Track B. |
