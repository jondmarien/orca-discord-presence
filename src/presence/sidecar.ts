/**
 * Fork sidecar transport (Orca-5): store a presence frame on the host
 * mailbox so a paired UI client can apply it. Feature-detects
 * `sidecar.resolvePlacement` / `sidecar.publish`. The UI Discord IPC
 * executor may still be `not-implemented` — companion HTTP stays the
 * Discord-visible fallback.
 *
 * @module presence/sidecar
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import type { DiscordActivity } from './activity'

/**
 * Host `call` subset used by the sidecar transport.
 */
export type SidecarHostCall = (method: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Placement fields this plugin actually branches on.
 */
export type SidecarPlacement = {
  mailboxAvailable: boolean
  companionStillValid: boolean
  lastPublishedAt: number | null
}

/**
 * Sidecar surface injected into the presence controller.
 */
export type PresenceSidecar = {
  resolvePlacement: () => Promise<SidecarPlacement | null>
  publish: (op: 'set' | 'clear', payload?: DiscordActivity) => Promise<boolean>
}

const SIDECAR_PAYLOAD_MAX_BYTES = 8 * 1024

/**
 * Parse `sidecar.resolvePlacement`. Requires `mailboxAvailable: true`.
 *
 * @param raw - Host result.
 */
export function parseSidecarPlacement(raw: unknown): SidecarPlacement | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const source = raw as Record<string, unknown>
  if (source.mailboxAvailable !== true) {
    return null
  }
  if (source.companionStillValid !== true) {
    return null
  }
  const lastPublishedAt =
    source.lastPublishedAt === null
      ? null
      : typeof source.lastPublishedAt === 'number' && Number.isFinite(source.lastPublishedAt)
        ? source.lastPublishedAt
        : null
  return {
    mailboxAvailable: true,
    companionStillValid: true,
    lastPublishedAt
  }
}

/**
 * Build `sidecar.publish` params for a SET frame.
 *
 * @param activity - Privacy-gated Discord activity.
 */
export function sidecarSetParams(activity: DiscordActivity): {
  channel: 'presence'
  op: 'set'
  payload: DiscordActivity
} {
  return { channel: 'presence', op: 'set', payload: activity }
}

function payloadFits(activity: DiscordActivity): boolean {
  return Buffer.byteLength(JSON.stringify(activity), 'utf8') <= SIDECAR_PAYLOAD_MAX_BYTES
}

/**
 * Create a try-call sidecar transport. Host misses become `null` / `false`.
 *
 * @param call - `orca.host.call`.
 */
export function createSidecarTransport(call: SidecarHostCall): PresenceSidecar {
  return {
    async resolvePlacement() {
      try {
        return parseSidecarPlacement(await call('sidecar.resolvePlacement', {}))
      } catch {
        return null
      }
    },
    async publish(op, payload) {
      try {
        if (op === 'clear') {
          const result = await call('sidecar.publish', { channel: 'presence', op: 'clear' })
          return Boolean(result && typeof result === 'object' && (result as { accepted?: boolean }).accepted)
        }
        if (!payload || !payloadFits(payload)) {
          return false
        }
        const result = await call('sidecar.publish', sidecarSetParams(payload))
        return Boolean(result && typeof result === 'object' && (result as { accepted?: boolean }).accepted)
      } catch {
        return false
      }
    }
  }
}
