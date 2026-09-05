import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_LOG_BYTES,
  appendCappedLog,
  createDiagnosticSink,
  formatLogLine,
  resolveLogFilePath
} from '../src/presence/log'

test('resolveLogFilePath prefers the env override, then XDG, then ~/.local/state', () => {
  expect(
    resolveLogFilePath(
      { ORCA_PRESENCE_LOG_FILE: '/tmp/custom.log' },
      { homedir: '/home/jon', tmpdir: '/tmp', platform: 'linux' }
    )
  ).toBe('/tmp/custom.log')
  expect(
    resolveLogFilePath(
      { XDG_STATE_HOME: '/custom/state' },
      { homedir: '/home/jon', tmpdir: '/tmp', platform: 'linux' }
    )
  ).toBe('/custom/state/chron0-discord-presence/plugin.log')
  expect(
    resolveLogFilePath({}, { homedir: '/home/jon', tmpdir: '/tmp', platform: 'linux' })
  ).toBe('/home/jon/.local/state/chron0-discord-presence/plugin.log')
})

test('resolveLogFilePath uses LOCALAPPDATA on Windows', () => {
  expect(
    resolveLogFilePath(
      { LOCALAPPDATA: 'C:\\Users\\jon\\AppData\\Local' },
      { homedir: 'C:\\Users\\jon', tmpdir: 'C:\\Temp', platform: 'win32' }
    )
  ).toBe(path.join('C:\\Users\\jon\\AppData\\Local', 'chron0-discord-presence', 'plugin.log'))
})

test('formatLogLine prefixes the plugin id and quotes spaced values', () => {
  const line = formatLogLine('error', 'discord.connect_failed', {
    reason: 'no discord ipc socket accepted a connection'
  })
  expect(line.startsWith('[chron0.discord-presence] error discord.connect_failed')).toBe(true)
  expect(line.includes('reason="no discord ipc socket accepted a connection"')).toBe(true)
})

test('formatLogLine redacts token-like keys', () => {
  const line = formatLogLine('info', 'bridge.publish', { url: 'http://127.0.0.1:3848', token: 's3cret' })
  expect(line.includes('token=***')).toBe(true)
  expect(line.includes('s3cret')).toBe(false)
})

test('createDiagnosticSink always emits errors and filters info when debug is off', () => {
  const host: string[] = []
  const files: string[] = []
  const sink = createDiagnosticSink({
    hostLog: (message) => host.push(message),
    filePath: '/unused.log',
    debugEnabled: false,
    append: (_path, line) => files.push(line)
  })
  sink.line('info', 'discord.set_activity', { sink: 'local' })
  sink.line('error', 'discord.connect_failed', { reason: 'down' })
  expect(host.length).toBe(1)
  expect(host[0]?.includes('discord.connect_failed')).toBe(true)
  expect(files.length).toBe(1)
  sink.setDebugEnabled(true)
  sink.line('info', 'discord.set_activity', { sink: 'local' })
  expect(host.length).toBe(2)
})

test('createDiagnosticSink onEmit receives only lines that were actually logged', () => {
  const emitted: string[] = []
  const sink = createDiagnosticSink({
    hostLog: () => {},
    filePath: '/unused.log',
    debugEnabled: false,
    append: () => {},
    onEmit: (line) => emitted.push(line)
  })
  sink.line('info', 'discord.set_activity', { sink: 'local' })
  sink.line('error', 'discord.connect_failed', { reason: 'down' })
  expect(emitted.length).toBe(1)
  expect(emitted[0]?.includes('discord.connect_failed')).toBe(true)
})

test('appendCappedLog rotates when the next write would exceed the cap', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-presence-log-'))
  const file = path.join(dir, 'plugin.log')
  writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES - 10))
  appendCappedLog(file, 'hello-world', MAX_LOG_BYTES)
  expect(readFileSync(`${file}.1`, 'utf8').length).toBe(MAX_LOG_BYTES - 10)
  expect(readFileSync(file, 'utf8').includes('hello-world')).toBe(true)
  rmSync(dir, { recursive: true, force: true })
})
