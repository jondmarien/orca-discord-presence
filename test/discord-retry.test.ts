import { expect, test } from 'bun:test'
import {
  CONNECT_RETRY_ATTEMPTS,
  CONNECT_RETRY_INITIAL_MS,
  CONNECT_RETRY_MAX_MS,
  HandshakeNotReadyError,
  connectRetryDelayMs,
  isFatalAppIdError,
  isRetryableConnectError
} from '../src/discord/retry'

test('backoff is 3s then 6s and caps at 15s', () => {
  expect(CONNECT_RETRY_ATTEMPTS).toBe(3)
  expect(CONNECT_RETRY_INITIAL_MS).toBe(3_000)
  expect(CONNECT_RETRY_MAX_MS).toBe(15_000)
  expect(connectRetryDelayMs(1)).toBe(3_000)
  expect(connectRetryDelayMs(2)).toBe(6_000)
  expect(connectRetryDelayMs(3)).toBe(12_000)
  expect(connectRetryDelayMs(4)).toBe(15_000)
  expect(connectRetryDelayMs(8)).toBe(15_000)
})

test('handshake-not-ready and handshake timeout are retryable', () => {
  expect(isRetryableConnectError(new HandshakeNotReadyError())).toBe(true)
  expect(isRetryableConnectError(new Error('discord handshake timed out'))).toBe(true)
  expect(isRetryableConnectError(new Error('discord connection closed'))).toBe(true)
})

test('missing socket and invalid App ID are not retried', () => {
  expect(isRetryableConnectError(new Error('no discord ipc socket accepted a connection'))).toBe(
    false
  )
  expect(
    isRetryableConnectError(
      new Error('Discord Application ID is invalid (expected a 17–20 digit snowflake).')
    )
  ).toBe(false)
  expect(isRetryableConnectError(new Error('404 Not Found'))).toBe(false)
  expect(isFatalAppIdError('Unknown application (404)')).toBe(true)
})
