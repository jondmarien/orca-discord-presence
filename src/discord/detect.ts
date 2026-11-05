/**
 * Discord client detection and selection.
 *
 * More than one Discord app can run at once (Vesktop, the desktop app, a
 * Flatpak or Snap build), each with its own IPC socket. This module finds
 * which sockets answer, names the client behind each, and turns the person's
 * `discordClient` choice into the candidate list the IPC client dials.
 *
 * @module discord/detect
 * @author Jonathan Marien
 * @date 2026-11-04
 */

import net from 'node:net'
import { defaultDiscordIpcCandidates } from './ipc'

/**
 * A Discord client whose IPC socket answered. `path` stays inside the worker.
 */
export type DetectedClient = {
  /** Stable across restarts: `<family>:<socket index>`, e.g. `vesktop:0`. */
  id: string
  /** Human-readable name shown in the panel. */
  label: string
  /** Socket or named-pipe path. Never sent to the panel, logs or Discord. */
  path: string
}

/**
 * What the panel may see of a client: no path (it reveals the home directory).
 */
export type ClientSummary = Pick<DetectedClient, 'id' | 'label'>

/**
 * Setting value meaning "first socket that answers".
 */
export const AUTO_CLIENT = 'auto'

/** How long one socket may take to accept before it counts as absent. */
const PROBE_TIMEOUT_MS = 300

/** Sockets probed at once; there are up to ~240 candidates on Linux. */
const PROBE_CONCURRENCY = 10

type Family = 'vesktop' | 'discord-flatpak' | 'discord-snap' | 'discord' | 'pipe'

const FAMILY_LABEL: Record<Exclude<Family, 'pipe'>, string> = {
  vesktop: 'Vesktop',
  'discord-flatpak': 'Discord (Flatpak)',
  'discord-snap': 'Discord (Snap)',
  discord: 'Discord'
}

function familyOf(path: string): Family {
  if (/^\\\\[?.]\\pipe\\/i.test(path)) {
    return 'pipe'
  }
  if (path.includes('dev.vencord.Vesktop')) {
    return 'vesktop'
  }
  if (path.includes('app/com.discordapp.Discord')) {
    return 'discord-flatpak'
  }
  if (path.includes('snap.discord')) {
    return 'discord-snap'
  }
  return 'discord'
}

/**
 * Name the client behind one socket path from its location alone.
 *
 * @param path - Socket or named-pipe path (`.../discord-ipc-N`).
 * @returns Stable `id` and base `label` (no duplicate-family index).
 */
export function classifyClientPath(path: string): ClientSummary {
  const family = familyOf(path)
  const index = Number(/discord-ipc-(\d+)$/.exec(path)?.[1] ?? 0)
  return {
    id: `${family}:${index}`,
    label: family === 'pipe' ? `Discord client #${index + 1}` : FAMILY_LABEL[family]
  }
}

/**
 * Default liveness probe: a connect that succeeds within the timeout is
 * "present". The socket is closed at once; no handshake is sent.
 */
function probeSocket(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path)
    const finish = (present: boolean) => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.on('error', () => {})
      socket.destroy()
      resolve(present)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * Injectable inputs for {@link detectDiscordClients} (tests pass fakes).
 */
export type DetectOptions = {
  /** Candidate paths; defaults to the live platform/env/uid list. */
  candidates?: string[]
  /** Liveness check; defaults to a real connect that closes immediately. */
  connect?: (path: string, timeoutMs: number) => Promise<boolean>
  /** Per-socket timeout in ms (default 300). */
  timeoutMs?: number
}

/**
 * Find the Discord clients that currently have a listening IPC socket.
 *
 * Duplicate paths (and duplicate ids, first wins) are dropped. Probing runs
 * in parallel, at most 10 at a time. Two live clients of one family get their
 * socket number in the label (`Discord (1)`, `Discord (2)`).
 *
 * Why: never throws. Detection feeds a convenience picker, so any failure
 * must degrade to "nothing detected", not break presence.
 *
 * @param opts - Optional candidates, connect function and timeout.
 * @returns Detected clients in candidate order, or `[]` on any error.
 */
export async function detectDiscordClients(opts: DetectOptions = {}): Promise<DetectedClient[]> {
  try {
    const { connect = probeSocket, timeoutMs = PROBE_TIMEOUT_MS } = opts
    const candidates = [...new Set(opts.candidates ?? defaultDiscordIpcCandidates())]
    const present: boolean[] = new Array(candidates.length).fill(false)
    let next = 0
    const worker = async () => {
      while (next < candidates.length) {
        const slot = next++
        present[slot] = await connect(candidates[slot], timeoutMs).catch(() => false)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, candidates.length) }, worker))

    const seen = new Set<string>()
    const found: DetectedClient[] = []
    candidates.forEach((path, slot) => {
      if (!present[slot]) {
        return
      }
      const { id, label } = classifyClientPath(path)
      if (!seen.has(id)) {
        seen.add(id)
        found.push({ id, label, path })
      }
    })
    const perFamily = new Map<string, number>()
    for (const client of found) {
      perFamily.set(client.label, (perFamily.get(client.label) ?? 0) + 1)
    }
    return found.map((client) => {
      if (client.id.startsWith('pipe:') || (perFamily.get(client.label) ?? 0) < 2) {
        return client
      }
      const index = Number(client.id.split(':')[1])
      return { ...client, label: `${client.label} (${index + 1})` }
    })
  } catch {
    return []
  }
}

/**
 * Turn the `discordClient` choice into the candidate list to dial.
 *
 * A chosen id that was detected dials only its own path. Anything else
 * (`auto`, or an id that is not running) uses the auto order; the latter is
 * flagged `fallback` so the panel can say so.
 *
 * @param choice - The `discordClient` setting value.
 * @param detected - The last detection result.
 * @param auto - The auto-order candidate list.
 */
export function resolveClientCandidates(
  choice: string,
  detected: readonly DetectedClient[],
  auto: string[]
): { candidates: string[]; fallback: boolean } {
  if (choice === AUTO_CLIENT) {
    return { candidates: auto, fallback: false }
  }
  const match = detected.find((client) => client.id === choice)
  return match ? { candidates: [match.path], fallback: false } : { candidates: auto, fallback: true }
}

/**
 * The client fields shared by `PresenceStatus` and the panel snapshot.
 */
export type ClientStatus = {
  /** The client actually connected, or `null`. */
  client: ClientSummary | null
  /** Every detected client, path-free. */
  clients: ClientSummary[]
  /** The chosen client is not running, so auto order was used. */
  clientFallback: boolean
}

/**
 * Build the path-free client status.
 *
 * @param input.connectedPath - Socket the IPC client is on, or `null`.
 * @param input.choice - The `discordClient` setting value.
 * @param input.detected - The last detection result.
 */
export function summarizeClients(input: {
  connectedPath: string | null
  choice: string
  detected: readonly DetectedClient[]
}): ClientStatus {
  const { connectedPath, choice, detected } = input
  const known = connectedPath ? detected.find((client) => client.path === connectedPath) : undefined
  const client = connectedPath
    ? known
      ? { id: known.id, label: known.label }
      : classifyClientPath(connectedPath)
    : null
  return {
    client,
    clients: detected.map(({ id, label }) => ({ id, label })),
    clientFallback: choice !== AUTO_CLIENT && !detected.some((entry) => entry.id === choice)
  }
}
