import { expect, test } from 'bun:test'
import { parseCompanionConfig } from '../companion/config'
import { DEFAULT_BRIDGE_PORT } from '../src/presence/bridge'
import { SHIPPED_APPLICATION_ID } from '../src/presence/settings'

test('defaults to loopback, shipped application id, and no token', () => {
  const config = parseCompanionConfig({})
  expect(config.bind).toBe('127.0.0.1')
  expect(config.port).toBe(DEFAULT_BRIDGE_PORT)
  expect(config.token).toBe('')
  expect(config.clientId).toBe(SHIPPED_APPLICATION_ID)
})

test('a non-loopback bind without a token is rejected', () => {
  expect(() => parseCompanionConfig({ ORCA_PRESENCE_BIND: '0.0.0.0' })).toThrow(/token/i)
  expect(() =>
    parseCompanionConfig({ ORCA_PRESENCE_BIND: '100.64.1.2', ORCA_PRESENCE_BRIDGE_TOKEN: '' })
  ).toThrow(/token/i)
})

test('a non-loopback bind is accepted when a token is set', () => {
  const config = parseCompanionConfig({
    ORCA_PRESENCE_BIND: '0.0.0.0',
    ORCA_PRESENCE_PORT: '4123',
    ORCA_PRESENCE_BRIDGE_TOKEN: 'shared',
    ORCA_PRESENCE_CLIENT_ID: '123456789012345678'
  })
  expect(config.bind).toBe('0.0.0.0')
  expect(config.port).toBe(4123)
  expect(config.token).toBe('shared')
  expect(config.clientId).toBe('123456789012345678')
})

test('port 0 is allowed so the OS can assign an ephemeral port', () => {
  expect(parseCompanionConfig({ ORCA_PRESENCE_PORT: '0' }).port).toBe(0)
})

test('an invalid port is rejected', () => {
  expect(() => parseCompanionConfig({ ORCA_PRESENCE_PORT: '-1' })).toThrow(/0–65535/)
  expect(() => parseCompanionConfig({ ORCA_PRESENCE_PORT: 'nope' })).toThrow(/0–65535/)
})
