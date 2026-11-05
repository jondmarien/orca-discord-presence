import { expect, test } from 'bun:test'
import {
  loadBridgeToken,
  migrateSettingsToken,
  saveBridgeToken,
  SECRETS_UNAVAILABLE_WARNING
} from '../src/presence/bridge-token'

type Call = { method: string; args?: object }

/** Fake host: `methods` maps a host method to its handler; absent means `has` is false. */
function fakeHost(methods: Record<string, (args?: object) => unknown>) {
  const calls: Call[] = []
  return {
    calls,
    has: (method: string) => method in methods,
    call: async (method: string, args?: object) => {
      calls.push({ method, args })
      const handler = methods[method]
      if (!handler) {
        throw new Error(`unexpected ${method}`)
      }
      return handler(args)
    }
  }
}

const keyring = { 'secrets.protection': () => ({ status: 'os-keyring' }) }

test('keyring available: reads the secret and reports the secrets store', async () => {
  const host = fakeHost({ ...keyring, 'secrets.get': () => ({ value: 'kept' }) })
  const result = await loadBridgeToken(host, 'from-settings')
  expect(result).toEqual({ token: 'kept', store: 'secrets' })
  expect(host.calls.find((call) => call.method === 'secrets.get')?.args).toEqual({ key: 'bridgeToken' })
})

test('keyring available but nothing stored: empty token, secrets store', async () => {
  const host = fakeHost({ ...keyring, 'secrets.get': () => ({ value: null }) })
  expect(await loadBridgeToken(host, '')).toEqual({ token: '', store: 'secrets' })
})

test('protection unavailable: settings fallback with a warning', async () => {
  const host = fakeHost({
    'secrets.protection': () => ({ status: 'unavailable' }),
    'secrets.get': () => ({ value: 'never-read' })
  })
  const result = await loadBridgeToken(host, 'from-settings')
  expect(result).toEqual({
    token: 'from-settings',
    store: 'settings',
    warning: 'secrets unavailable; bridge token stored in plugin settings'
  })
  expect(result.warning).toBe(SECRETS_UNAVAILABLE_WARNING)
  expect(host.calls.some((call) => call.method === 'secrets.get')).toBe(false)
})

test('host without secrets methods: settings fallback', async () => {
  const host = fakeHost({})
  const result = await loadBridgeToken(host, 'from-settings')
  expect(result.store).toBe('settings')
  expect(result.token).toBe('from-settings')
  expect(result.warning).toBe(SECRETS_UNAVAILABLE_WARNING)
})

test('a thrown secrets.get falls back to settings without throwing', async () => {
  const host = fakeHost({
    ...keyring,
    'secrets.get': () => {
      throw new Error('keyring locked')
    }
  })
  const result = await loadBridgeToken(host, 'from-settings')
  expect(result.store).toBe('settings')
  expect(result.token).toBe('from-settings')
  expect(result.warning).toBe(SECRETS_UNAVAILABLE_WARNING)
})

test('saveBridgeToken writes the secret store when the keyring is available', async () => {
  const host = fakeHost({
    ...keyring,
    'secrets.set': () => null,
    'settings.set': () => null
  })
  expect(await saveBridgeToken(host, 'tok')).toBe('secrets')
  expect(host.calls.map((call) => call.method)).toEqual(['secrets.protection', 'secrets.set'])
  expect(host.calls[1]?.args).toEqual({ key: 'bridgeToken', value: 'tok' })
})

test('saveBridgeToken with an empty token deletes the secret', async () => {
  const host = fakeHost({ ...keyring, 'secrets.delete': () => null })
  expect(await saveBridgeToken(host, '')).toBe('secrets')
  expect(host.calls[1]).toEqual({ method: 'secrets.delete', args: { key: 'bridgeToken' } })
})

test('saveBridgeToken writes plugin settings when secrets are unavailable', async () => {
  const host = fakeHost({
    'secrets.protection': () => ({ status: 'unavailable' }),
    'secrets.set': () => {
      throw new Error('must not be called')
    },
    'settings.set': () => null
  })
  expect(await saveBridgeToken(host, 'tok')).toBe('settings')
  expect(host.calls.at(-1)).toEqual({ method: 'settings.set', args: { key: 'bridgeToken', value: 'tok' } })
})

test('saveBridgeToken rethrows and never writes settings when the keyring set throws', async () => {
  const host = fakeHost({
    ...keyring,
    'secrets.set': () => {
      throw new Error('denied')
    },
    'settings.set': () => null
  })
  await expect(saveBridgeToken(host, 'tok')).rejects.toThrow('denied')
  expect(host.calls.some((call) => call.method === 'settings.set')).toBe(false)
})

test('saveBridgeToken rethrows and never writes settings when the keyring delete throws', async () => {
  const host = fakeHost({
    ...keyring,
    'secrets.delete': () => {
      throw new Error('denied')
    },
    'settings.set': () => null
  })
  await expect(saveBridgeToken(host, '')).rejects.toThrow('denied')
  expect(host.calls.some((call) => call.method === 'settings.set')).toBe(false)
})

test('migrateSettingsToken moves a settings token into secrets, then blanks the setting', async () => {
  const host = fakeHost({
    ...keyring,
    'secrets.get': () => ({ value: null }),
    'secrets.set': () => null,
    'settings.set': () => null
  })
  const result = await migrateSettingsToken(host, 'legacy')
  expect(result).toEqual({ token: 'legacy', store: 'secrets' })
  expect(host.calls.map((call) => call.method)).toEqual([
    'secrets.protection',
    'secrets.get',
    'secrets.set',
    'settings.set'
  ])
  expect(host.calls.at(-2)?.args).toEqual({ key: 'bridgeToken', value: 'legacy' })
  expect(host.calls.at(-1)?.args).toEqual({ key: 'bridgeToken', value: '' })
})

test('migrateSettingsToken keeps an existing secret and still scrubs the settings copy', async () => {
  const host = fakeHost({
    ...keyring,
    'secrets.get': () => ({ value: 'newer' }),
    'secrets.set': () => {
      throw new Error('must not overwrite')
    },
    'settings.set': () => null
  })
  const result = await migrateSettingsToken(host, 'legacy')
  expect(result.token).toBe('newer')
  expect(host.calls.at(-1)?.args).toEqual({ key: 'bridgeToken', value: '' })
})

test('migrateSettingsToken leaves settings alone when secrets are unavailable', async () => {
  const host = fakeHost({ 'secrets.protection': () => ({ status: 'unavailable' }) })
  const result = await migrateSettingsToken(host, 'legacy')
  expect(result.store).toBe('settings')
  expect(result.token).toBe('legacy')
  expect(host.calls.some((call) => call.method === 'settings.set')).toBe(false)
})

test('migrateSettingsToken does not blank settings when the secrets write fails', async () => {
  const host = fakeHost({
    ...keyring,
    'secrets.get': () => ({ value: null }),
    'secrets.set': () => {
      throw new Error('denied')
    },
    'settings.set': () => null
  })
  const result = await migrateSettingsToken(host, 'legacy')
  expect(result.token).toBe('legacy')
  expect(host.calls.filter((call) => call.method === 'settings.set')).toEqual([])
})

test('migrateSettingsToken with no settings token is a plain load', async () => {
  const host = fakeHost({ ...keyring, 'secrets.get': () => ({ value: 'kept' }) })
  expect(await migrateSettingsToken(host, '')).toEqual({ token: 'kept', store: 'secrets' })
  expect(host.calls.some((call) => call.method === 'settings.set')).toBe(false)
})
