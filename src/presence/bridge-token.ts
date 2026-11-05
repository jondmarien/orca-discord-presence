/**
 * Bridge token storage: Orca's OS-keyring-backed secrets when available,
 * plugin settings otherwise.
 *
 * Why: the companion bridge token is a bearer secret. `secrets:own` keeps it
 * out of the plain-text settings file and out of settings exports. Linux hosts
 * without a keyring report `secrets.protection` as `unavailable` and refuse
 * `secrets.set`, so the bridge must keep working from plugin settings there,
 * with a visible warning instead of a silent downgrade.
 *
 * @module presence/bridge-token
 * @author Jonathan Marien
 * @date 2026-11-04
 */

/** Where the bridge token currently lives. */
export type TokenStore = 'secrets' | 'settings'

/** Minimal host surface this module needs (a structural subset of `orca.host`). */
export type TokenHost = {
  has(method: string): boolean
  call(method: string, args?: object): Promise<unknown>
}

/** Result of reading the token. `warning` is set only on the settings fallback. */
export type LoadedBridgeToken = { token: string; store: TokenStore; warning?: string }

const TOKEN_KEY = 'bridgeToken'

/** Shown by **Show Status** when the token has to live in plugin settings. */
export const SECRETS_UNAVAILABLE_WARNING = 'secrets unavailable; bridge token stored in plugin settings'

/**
 * Whether the OS keyring backs `secrets.*` right now.
 *
 * Why: any failure (missing method, throw, unexpected shape) counts as
 * unavailable so callers degrade instead of throwing.
 */
async function keyringAvailable(host: TokenHost): Promise<boolean> {
  if (!host.has('secrets.protection')) {
    return false
  }
  try {
    const result = (await host.call('secrets.protection')) as { status?: unknown } | null
    return result?.status === 'os-keyring'
  } catch {
    return false
  }
}

/**
 * Read the bridge token. Order: keyring secret, else the settings value.
 *
 * Env overrides (`BRIDGE_ENV`) still win later through `applyBridgeEnvOverrides`.
 *
 * @param host - Host `has`/`call` pair.
 * @param settingsToken - Token currently held in plugin settings (may be empty).
 */
export async function loadBridgeToken(host: TokenHost, settingsToken: string): Promise<LoadedBridgeToken> {
  const fallback: LoadedBridgeToken = {
    token: settingsToken,
    store: 'settings',
    warning: SECRETS_UNAVAILABLE_WARNING
  }
  if (!host.has('secrets.get') || !(await keyringAvailable(host))) {
    return fallback
  }
  try {
    const result = (await host.call('secrets.get', { key: TOKEN_KEY })) as { value?: unknown } | null
    return { token: typeof result?.value === 'string' ? result.value : '', store: 'secrets' }
  } catch {
    return fallback
  }
}

/**
 * Write the bridge token to the same store {@link loadBridgeToken} would read.
 *
 * An empty token deletes the secret. If the secrets write throws, the token is
 * kept in plugin settings so the bridge still works.
 *
 * @returns The store that now holds the token.
 */
export async function saveBridgeToken(host: TokenHost, token: string): Promise<TokenStore> {
  const method = token ? 'secrets.set' : 'secrets.delete'
  if (host.has(method) && (await keyringAvailable(host))) {
    try {
      await host.call(method, token ? { key: TOKEN_KEY, value: token } : { key: TOKEN_KEY })
      return 'secrets'
    } catch {
      // Fall through to plugin settings.
    }
  }
  await host.call('settings.set', { key: TOKEN_KEY, value: token })
  return 'settings'
}

/**
 * Load the token and, on the secrets store, move any plaintext settings copy
 * into it (one-time upgrade from the pre-secrets plugin).
 *
 * Order matters: `secrets.set` first, then blank the setting, so a failed
 * secrets write never loses the token. An existing secret wins over the
 * settings copy, which is still scrubbed.
 */
export async function migrateSettingsToken(host: TokenHost, settingsToken: string): Promise<LoadedBridgeToken> {
  const loaded = await loadBridgeToken(host, settingsToken)
  if (loaded.store !== 'secrets' || !settingsToken) {
    return loaded
  }
  let token = loaded.token
  try {
    if (!token) {
      await host.call('secrets.set', { key: TOKEN_KEY, value: settingsToken })
      token = settingsToken
    }
    await host.call('settings.set', { key: TOKEN_KEY, value: '' })
  } catch {
    return { token: token || settingsToken, store: 'secrets' }
  }
  return { token, store: 'secrets' }
}
