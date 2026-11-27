import { expect, test } from 'bun:test'
import { DEFAULT_SETTINGS } from '../src/presence/settings'
import { createDisposer, type OrcaHost } from '../src/worker/host'
import {
  createPersistence,
  SESSION_STORAGE_KEY,
  TIMELINE_STORAGE_KEY
} from '../src/worker/persistence'

test('persistence restores timeline/session, coalesces saves, flushes on demand, and retries rejected statusBar updates', async () => {
  const storage = new Map<string, unknown>([
    [SESSION_STORAGE_KEY, { startMs: 1_000, lastActiveMs: 2_000 }]
  ])
  const storageSets: string[] = []
  const statusUpdates: unknown[] = []
  let failNextStatusBar = true
  let clock = 5_000

  const host: OrcaHost['host'] = {
    has: (method) => ['storage.get', 'storage.set', 'statusBar.update'].includes(method),
    call: async (method, args) => {
      if (method === 'storage.get') return { value: storage.get(String(args?.key)) }
      if (method === 'storage.set') {
        storageSets.push(String(args?.key))
        storage.set(String(args?.key), args?.value)
        return null
      }
      if (method === 'statusBar.update') {
        statusUpdates.push(args)
        if (failNextStatusBar) {
          failNextStatusBar = false
          throw new Error('transient')
        }
        return null
      }
      return null
    }
  }

  const disposer = createDisposer()
  const persistence = await createPersistence({
    host,
    disposer,
    now: () => clock,
    saveIntervalMs: 30
  })

  expect(persistence.sessionStartMs()).toBe(1_000)
  persistence.recordTimeline(['working'])
  persistence.scheduleSave()
  persistence.scheduleSave()
  expect(storageSets).toEqual([])
  await persistence.flush()
  expect(storageSets).toEqual([TIMELINE_STORAGE_KEY, SESSION_STORAGE_KEY])

  const statusInput = {
    status: {
      enabled: true,
      connected: true,
      client: null,
      clients: [],
      clientFallback: false,
      bridgeEnabled: false,
      sink: 'local' as const,
      detailLevel: 'generic' as const,
      lastActivity: null,
      logFile: null,
      heldClear: false,
      bridgeFailing: false,
      localFailing: false
    },
    settings: DEFAULT_SETTINGS,
    agentState: 'working' as const,
    agentCount: 1,
    stateStartedAtMs: 4_000
  }

  // First publish rejects -> retry with identical payload must NOT be deduplicated away.
  persistence.publishStatusBar(statusInput)
  await new Promise((resolve) => setTimeout(resolve, 10))
  persistence.publishStatusBar(statusInput)
  await new Promise((resolve) => setTimeout(resolve, 10))
  // Third identical publish succeeds and is deduplicated.
  persistence.publishStatusBar(statusInput)
  expect(statusUpdates).toHaveLength(2)

  disposer.disposeAll()
})
