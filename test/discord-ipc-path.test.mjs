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
