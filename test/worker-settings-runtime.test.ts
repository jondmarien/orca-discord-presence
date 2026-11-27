import { expect, test } from 'bun:test'
import { createDisposer, type OrcaHost } from '../src/worker/host'
import { createSettingsRuntime } from '../src/worker/settings-runtime'

function makeHost(options: {
  stored?: Record<string, unknown>
  secret?: string
  protection?: 'os-keyring' | 'unavailable'
  failSecretSet?: boolean
} = {}) {
  const stored = { ...(options.stored ?? {}) }
  let secret = options.secret ?? ''
  const calls: Array<[string, Record<string, unknown> | undefined]> = []
  let feed: ((e: { key: string }) => void) | null = null
  let disposed = false
  const logs: string[] = []

  const orca: OrcaHost = {
    log: (msg) => void logs.push(msg),
    commands: { register: () => {} },
    events: { on: () => {} },
    host: {
      has: (method) => method.startsWith('secrets.'),
      call: async (method, args) => {
        calls.push([method, args])
        if (method === 'settings.get') return { settings: { ...stored } }
        if (method === 'settings.set') {
          stored[String(args?.key)] = args?.value
          return null
        }
        if (method === 'secrets.protection') return { status: options.protection ?? 'os-keyring' }
        if (method === 'secrets.get') return { value: secret }
        if (method === 'secrets.set') {
          if (options.failSecretSet) throw new Error('keyring locked')
          secret = String(args?.value ?? '')
          return null
        }
        if (method === 'secrets.delete') {
          secret = ''
          return null
        }
        return null
      }
    },
    settings: {
      onDidChange: (handler) => {
        feed = handler
        return {
          dispose: () => {
            disposed = true
          }
        }
      }
    }
  }
  return {
    orca,
    stored,
    calls,
    logs,
    emitChange: (key: string) => feed?.({ key }),
    isDisposed: () => disposed
  }
}

test('secrets-first atomic persist aborts before writing other settings when keyring fails', async () => {
  const host = makeHost({ protection: 'os-keyring', failSecretSet: true })
  const disposer = createDisposer()
  const runtime = await createSettingsRuntime({ orca: host.orca, disposer, env: {} })
  let applied = false

  await expect(
    runtime.persist(
      { ...runtime.current(), showBranch: true, bridgeToken: 'new-secret' },
      async () => {
        applied = true
      }
    )
  ).rejects.toThrow('keyring locked')

  expect(applied).toBe(false)
  expect(host.calls.some(([m]) => m === 'settings.set')).toBe(false)
  disposer.disposeAll()
})

test('onDidChange reuses secrets-held token without re-probing OS keyring on unrelated edits', async () => {
  const host = makeHost({ protection: 'os-keyring', secret: 'kept-secret' })
  const disposer = createDisposer()
  const runtime = await createSettingsRuntime({ orca: host.orca, disposer, env: {}, debounceMs: 10 })

  const applied: string[] = []
  runtime.watch(async (next) => {
    runtime.setCurrent(next)
    applied.push(`${next.detailLevel}:${next.bridgeToken}`)
  })

  host.calls.length = 0
  host.stored.detailLevel = 'full'
  host.emitChange('detailLevel')
  await new Promise((resolve) => setTimeout(resolve, 40))

  expect(applied).toEqual(['full:kept-secret'])
  expect(host.calls.some(([m]) => m.startsWith('secrets.'))).toBe(false)
  disposer.disposeAll()
  expect(host.isDisposed()).toBe(true)
})
