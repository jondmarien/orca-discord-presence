import { expect, test } from 'bun:test'
import {
  createSidecarTransport,
  parseSidecarPlacement,
  sidecarSetParams,
  type SidecarHostCall
} from '../src/presence/sidecar'

const PLACEMENT = {
  pluginProcess: 'runtime-host',
  discordIpcMustRun: 'machine-with-discord',
  hostForwards: 'sidecar-frames',
  hostDoesNotForward: ['discord-ipc-bytes', 'companion-http'],
  mailboxAvailable: true,
  companionStillValid: true,
  lastPublishedAt: null
}

test('parseSidecarPlacement accepts the fork placement object', () => {
  expect(parseSidecarPlacement(PLACEMENT)).toEqual({
    mailboxAvailable: true,
    companionStillValid: true,
    lastPublishedAt: null
  })
})

test('parseSidecarPlacement rejects a missing mailbox or junk', () => {
  expect(parseSidecarPlacement(null)).toBeNull()
  expect(parseSidecarPlacement({ mailboxAvailable: false, companionStillValid: true, lastPublishedAt: null })).toBeNull()
  expect(parseSidecarPlacement({ mailboxAvailable: true })).toBeNull()
})

test('sidecarSetParams builds a presence set frame under the 8 KiB cap', () => {
  const params = sidecarSetParams({ details: 'Working in Orca', assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-idle', small_text: 'idle' } })
  expect(params).toEqual({
    channel: 'presence',
    op: 'set',
    payload: {
      details: 'Working in Orca',
      assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-idle', small_text: 'idle' }
    }
  })
})

test('createSidecarTransport feature-detects resolve and publish', async () => {
  const calls: Array<{ method: string; args?: Record<string, unknown> }> = []
  const call: SidecarHostCall = async (method, args) => {
    calls.push({ method, args })
    if (method === 'sidecar.resolvePlacement') {
      return PLACEMENT
    }
    if (method === 'sidecar.publish') {
      return { accepted: true, delivery: 'stored', placement: { ...PLACEMENT, lastPublishedAt: 1 } }
    }
    throw new Error(`unexpected ${method}`)
  }
  const sidecar = createSidecarTransport(call)
  expect(await sidecar.resolvePlacement()).toEqual({
    mailboxAvailable: true,
    companionStillValid: true,
    lastPublishedAt: null
  })
  expect(
    await sidecar.publish('set', {
      details: 'Working in Orca',
      assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-idle', small_text: 'idle' }
    })
  ).toBe(true)
  expect(await sidecar.publish('clear')).toBe(true)
  expect(calls.some((entry) => entry.method === 'sidecar.publish' && entry.args?.op === 'clear')).toBe(true)
})

test('createSidecarTransport returns null / false when the host lacks sidecar', async () => {
  const call: SidecarHostCall = async () => {
    throw new Error('capability_denied')
  }
  const sidecar = createSidecarTransport(call)
  expect(await sidecar.resolvePlacement()).toBeNull()
  expect(await sidecar.publish('set', { details: 'x', assets: { large_image: 'orca', large_text: 'Orca', small_image: 'state-idle', small_text: 'idle' } })).toBe(false)
})
