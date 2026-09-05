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
