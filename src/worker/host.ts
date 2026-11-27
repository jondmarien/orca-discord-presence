/**
 * Orca worker host API types, RPC helpers, and deterministic resource disposer.
 *
 * @module worker/host
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import type { createDiscordClient } from '../discord/client'
import type { detectDiscordClients } from '../discord/detect'

/**
 * Payload of the host `agent.status.changed` event used by this plugin.
 *
 * `state` is an Orca agent status (`working`, `blocked`, `waiting`, `done`,
 * or an unrecognized future value). `receivedAt` is the host timestamp in
 * milliseconds; the activity builder may convert it to a Discord start
 * timestamp when `showElapsed` is on.
 */
export type AgentStatusPayload = {
  state: string
  receivedAt: number
  workspaceId?: string | null
  workspaceListId?: string
  terminalId?: string
  sessionId?: string
  paneKey?: string
  title?: string
  mainAgent?: {
    state?: string
    outcome?: string
    stateStartedAt?: number
  }
}

/**
 * Subset of `workspace.readContext` this plugin reads.
 *
 * `terminals` is only used for its length. Missing `displayName` / `branch`
 * are treated as absent by the activity builder. The `workspace.changed`
 * event carries the same shape as `{ context }`, where `context` is `null`
 * when no workspace is focused.
 */
export type WorkspaceContext = {
  workspaceId?: string
  displayName?: string
  branch?: string
  terminals: readonly unknown[]
}

/**
 * Host object Orca injects into `activate`. Aligned with Orca 1.4.278
 * `OrcaWorkerApi` (`orca/worker`) while staying standalone for CI typechecks.
 */
export type OrcaHost = {
  /** Host API version when supplied by Orca (`{ major: 1, minor: 10 }` on 1.4.278). */
  readonly api?: { readonly major: number; readonly minor: number }
  /** Write a line to the plugin log (also used by **Show Status**). */
  log: (message: string) => void
  commands: {
    /**
     * Register a command contributed in `orca-plugin.json`.
     * Host `invokeCommand` may pass optional `args`.
     */
    register: (id: string, handler: (args?: Record<string, unknown>) => Promise<unknown>) => void
  }
  events: {
    /**
     * Subscribe to a host event. Manifest-declared events also wake a
     * sleeping worker; dynamic-only subscriptions do not.
     */
    on: (event: string, handler: (payload?: unknown) => Promise<void> | void) => void
  }
  host: {
    /**
     * True when the connected Orca exposes `method`.
     *
     * Why: newer host methods are guarded by this so an older Orca degrades
     * cleanly instead of throwing.
     */
    has: (method: string) => boolean
    /**
     * Invoke a host method (`settings.*`, `storage.*`, `secrets.*`,
     * `workspace.readContext`, `workspace.list`, `agents.list`,
     * `terminal.focus`, `agent.listSessions`, `statusBar.update`,
     * `notifications.show`).
     */
    call: (method: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  /** Native Settings page change feed. Absent on older hosts. */
  settings?: {
    onDidChange(handler: (e: { key: string }) => void): { dispose(): void }
  }
  /** Panel RPC channel. Absent on older hosts or browser clients. */
  panels?: {
    handle(name: string, fn: (input: unknown) => unknown): { dispose(): void }
    post(name: string, payload: unknown): void
  }
}

/** Test seams for {@link activate}: Discord detection and client construction. */
export type ActivateDeps = {
  detect?: typeof detectDiscordClients
  createClient?: typeof createDiscordClient
}

/** Standard host disposable returned by subscriptions and RPC registrations. */
export type Disposable = {
  dispose(): void
}

/**
 * Map a settings value to what `settings.set` accepts for a declared key.
 *
 * Why: `machineLabel` is declared `string` (default `""`) but held as `null`
 * in memory when unset; the host validates writes against the declaration and
 * would reject `null`.
 */
export function toSettingsValue(value: unknown): unknown {
  return value === null ? '' : value
}

/**
 * Error with a host-style `code`, thrown from panel handlers so the frame's
 * `plugin.request` rejects with `invalid_params` instead of a bare message.
 */
export function invalidParams(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_params' })
}

/**
 * Deterministic lifecycle collector for timers, intervals, and host subscriptions.
 * Guarantees zero leaked listeners or handles after `deactivate()`.
 */
export type Disposer = {
  add: (item: Disposable | null | undefined) => void
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout> | null) => void
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  disposeAll: () => void
  isDisposed: () => boolean
}

export function createDisposer(): Disposer {
  let disposed = false
  const disposables = new Set<Disposable>()
  const timeouts = new Set<ReturnType<typeof setTimeout>>()
  const intervals = new Set<ReturnType<typeof setInterval>>()

  return {
    add(item) {
      if (!item) return
      if (disposed) {
        try {
          item.dispose()
        } catch {
          // Best-effort cleanup.
        }
        return
      }
      disposables.add(item)
    },
    setTimeout(fn, ms) {
      const timer = setTimeout(() => {
        timeouts.delete(timer)
        if (!disposed) {
          fn()
        }
      }, ms)
      timer.unref?.()
      if (disposed) {
        clearTimeout(timer)
      } else {
        timeouts.add(timer)
      }
      return timer
    },
    clearTimeout(timer) {
      if (!timer) return
      clearTimeout(timer)
      timeouts.delete(timer)
    },
    setInterval(fn, ms) {
      const interval = setInterval(() => {
        if (!disposed) {
          fn()
        }
      }, ms)
      interval.unref?.()
      if (disposed) {
        clearInterval(interval)
      } else {
        intervals.add(interval)
      }
      return interval
    },
    disposeAll() {
      if (disposed) return
      disposed = true
      for (const timer of timeouts) {
        clearTimeout(timer)
      }
      timeouts.clear()
      for (const interval of intervals) {
        clearInterval(interval)
      }
      intervals.clear()
      for (const item of disposables) {
        try {
          item.dispose()
        } catch {
          // Best-effort cleanup.
        }
      }
      disposables.clear()
    },
    isDisposed: () => disposed
  }
}
