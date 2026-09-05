/**
 * Worker → panel diagnostics mailbox (Orca-2).
 *
 * The worker writes a redacted {@link PresencePanelSnapshot} to plugin
 * storage under {@link DIAGNOSTICS_STORAGE_KEY}. The sidebar polls
 * `storage.get` so logs update without remounting. Values are capped under
 * the panel 64 KiB envelope.
 *
 * @module presence/diagnostics-store
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import type { PresencePanelSnapshot } from './panel-snapshot'

/**
 * Storage key the worker writes and the panel polls.
 */
export const DIAGNOSTICS_STORAGE_KEY = 'diagnostics.snapshot'

/**
 * Soft cap (~60 KiB) so the JSON stays under the panel 64 KiB envelope.
 */
export const MAX_PANEL_STORAGE_JSON_BYTES = 60 * 1024

/**
 * Host `call` subset used by the diagnostics writer.
 */
export type DiagnosticsHostCall = (
  method: string,
  args?: Record<string, unknown>
) => Promise<unknown>

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Shrink a snapshot so it fits {@link MAX_PANEL_STORAGE_JSON_BYTES}.
 * Drops older log lines first, then truncates activity text.
 *
 * @param snapshot - Redacted panel snapshot.
 */
export function capPanelSnapshotForStorage(snapshot: PresencePanelSnapshot): PresencePanelSnapshot {
  if (jsonBytes(snapshot) <= MAX_PANEL_STORAGE_JSON_BYTES) {
    return snapshot
  }
  let next: PresencePanelSnapshot = {
    ...snapshot,
    logs: snapshot.logs.slice(-5)
  }
  if (jsonBytes(next) <= MAX_PANEL_STORAGE_JSON_BYTES) {
    return next
  }
  const activity = next.status.lastActivity
  return {
    ...next,
    logs: [],
    status: {
      ...next.status,
      lastActivity: activity
        ? {
            details: activity.details.slice(0, 80),
            state: activity.state ? activity.state.slice(0, 80) : activity.state
          }
        : null
    }
  }
}

/**
 * Best-effort parse of a `storage.get` value. Junk becomes `null`.
 *
 * @param value - Host storage value.
 */
export function parseStoredPanelSnapshot(value: unknown): PresencePanelSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record.version !== 'string' || !record.status || typeof record.status !== 'object') {
    return null
  }
  if (!record.fields || typeof record.fields !== 'object') {
    return null
  }
  return value as PresencePanelSnapshot
}

/**
 * Write a capped snapshot to `storage.set`. Host misses return `false`.
 *
 * @param call - `orca.host.call`.
 * @param snapshot - Redacted panel snapshot.
 */
export async function writeDiagnosticsSnapshot(
  call: DiagnosticsHostCall,
  snapshot: PresencePanelSnapshot
): Promise<boolean> {
  try {
    const result = await call('storage.set', {
      key: DIAGNOSTICS_STORAGE_KEY,
      value: capPanelSnapshotForStorage(snapshot)
    })
    return Boolean(result && typeof result === 'object' && (result as { ok?: boolean }).ok)
  } catch {
    return false
  }
}
