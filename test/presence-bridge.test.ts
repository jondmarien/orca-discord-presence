import { expect, test } from 'bun:test'
import http from 'node:http'
import {
  applyBridgeEnvOverrides,
  createBridgeTransport,
  isLoopbackHost,
  normalizeBridgeUrl,
  resolveBridgeTarget
} from '../src/presence/bridge'
import { DEFAULT_SETTINGS, type PresenceSettings } from '../src/presence/settings'

function settingsWith(overrides: Partial<PresenceSettings>): PresenceSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

test('isLoopbackHost covers ipv4, localhost, and ipv6', () => {
  expect(isLoopbackHost('127.0.0.1')).toBe(true)
  expect(isLoopbackHost('127.0.0.9')).toBe(true)
  expect(isLoopbackHost('localhost')).toBe(true)
  expect(isLoopbackHost('::1')).toBe(true)
  expect(isLoopbackHost('[::1]')).toBe(true)
  expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true)
  expect(isLoopbackHost('0.0.0.0')).toBe(false)
  expect(isLoopbackHost('100.64.1.2')).toBe(false)
  expect(isLoopbackHost('::')).toBe(false)
})

test('normalizeBridgeUrl strips /activity and rejects junk', () => {
  expect(normalizeBridgeUrl('http://100.64.1.2:3848/activity/')).toBe('http://100.64.1.2:3848')
  expect(normalizeBridgeUrl('https://win.example:3848')).toBe('https://win.example:3848')
  expect(normalizeBridgeUrl('file:///tmp/x')).toBe('')
})

test('resolveBridgeTarget stays null until enabled with a usable url', () => {
  expect(resolveBridgeTarget(settingsWith({}))).toBeNull()
  expect(
    resolveBridgeTarget(settingsWith({ bridgeEnabled: true, bridgeUrl: '' }))
  ).toBeNull()
  expect(
    resolveBridgeTarget(
      settingsWith({ bridgeEnabled: true, bridgeUrl: 'http://100.64.1.2:3848', bridgeToken: '' })
    )
  ).toBeNull()
  expect(
    resolveBridgeTarget(
      settingsWith({ bridgeEnabled: true, bridgeUrl: 'http://127.0.0.1:3848', bridgeToken: '' })
    )
  ).toEqual({ url: 'http://127.0.0.1:3848', token: '' })
  expect(
    resolveBridgeTarget(
      settingsWith({
        bridgeEnabled: true,
        bridgeUrl: 'http://100.64.1.2:3848',
        bridgeToken: 'tok'
      })
    )
  ).toEqual({ url: 'http://100.64.1.2:3848', token: 'tok' })
})

test('applyBridgeEnvOverrides overlays url, token, and the enable flag', () => {
  const enabled = applyBridgeEnvOverrides(DEFAULT_SETTINGS, {
    ORCA_PRESENCE_BRIDGE_ENABLED: 'true',
    ORCA_PRESENCE_BRIDGE_URL: 'http://100.64.1.2:3848',
    ORCA_PRESENCE_BRIDGE_TOKEN: 'env-secret'
  })
  expect(enabled.bridgeEnabled).toBe(true)
  expect(enabled.bridgeUrl).toBe('http://100.64.1.2:3848')
  expect(enabled.bridgeToken).toBe('env-secret')

  const disabled = applyBridgeEnvOverrides(
    { ...DEFAULT_SETTINGS, bridgeEnabled: true },
    { ORCA_PRESENCE_BRIDGE_ENABLED: '0' }
  )
  expect(disabled.bridgeEnabled).toBe(false)
})

test('createBridgeTransport POSTs and DELETEs activity against a fake server', async () => {
  const requests: { method: string; auth: string | undefined; body: string }[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8')
      })
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const url = `http://127.0.0.1:${port}`
  const bridge = createBridgeTransport()
  await bridge.publish(url, 's3cret', { details: 'Working in Orca', assets: {
    large_image: 'orca',
    large_text: 'Orca',
    small_image: 'state-working',
    small_text: 'working'
  } })
  await bridge.clear(url, 's3cret')
  expect(requests.length).toBe(2)
  expect(requests[0]?.method).toBe('POST')
  expect(requests[0]?.auth).toBe('Bearer s3cret')
  expect(requests[0]?.body.includes('Working in Orca')).toBe(true)
  expect(requests[1]?.method).toBe('DELETE')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
})
