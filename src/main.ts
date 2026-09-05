import os from 'node:os'
import { createDiscordClient } from './discord/client'
import { createPresenceController, type PresenceController } from './presence/controller'
import { normalizeSettings, nextDetailLevel, toggleField, type PresenceSettings } from './presence/settings'

// Why: the worker is reaped after PLUGIN_WORKER_IDLE_REAP_MS (5 min) of no host
// calls. This poll both refreshes that clock and catches branch switches, which
// emit no event.
const HEARTBEAT_MS = 90_000

const TOGGLE_COMMANDS = {
  'presence.toggle-branch': 'showBranch',
  'presence.toggle-agent-state': 'showAgentState',
  'presence.toggle-terminals': 'showTerminals',
  'presence.toggle-machine': 'showMachine',
  'presence.toggle-elapsed': 'showElapsed'
} as const

type ToggleCommandId = keyof typeof TOGGLE_COMMANDS

type AgentStatusPayload = {
  state: string
  receivedAt: number
}

type WorkspaceContext = {
  displayName?: string
  branch?: string
  terminals: readonly unknown[]
}

export type OrcaHost = {
  log: (message: string) => void
  commands: {
    register: (id: string, handler: () => Promise<unknown>) => void
  }
  events: {
    on: (event: string, handler: (payload?: unknown) => Promise<void> | void) => void
  }
  host: {
    call: (method: string, args?: Record<string, unknown>) => Promise<unknown>
  }
}

let controller: PresenceController | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null

export default async function activate(orca: OrcaHost) {
  const stored = (await orca.host.call('settings.get').catch(() => ({ settings: {} }))) as {
    settings?: unknown
  }
  let settings = normalizeSettings(stored?.settings)

  controller = createPresenceController({
    client: createDiscordClient({
      clientId: settings.applicationId,
      log: (message) => orca.log(message)
    }),
    settings,
    log: (message) => orca.log(message)
  })

  async function persist(nextSettings: PresenceSettings) {
    settings = nextSettings
    for (const [key, value] of Object.entries(nextSettings)) {
      await orca.host.call('settings.set', { key, value }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        orca.log(`failed to persist ${key}: ${message}`)
      })
    }
    await controller?.setSettings(nextSettings)
  }

  async function refresh(agentState?: AgentStatusPayload) {
    const context = (await orca.host.call('workspace.readContext').catch(() => null)) as
      | WorkspaceContext
      | null
    if (!context) {
      return
    }
    await controller?.update({
      displayName: context.displayName,
      branch: context.branch,
      terminalCount: context.terminals.length,
      machineName: os.hostname(),
      ...(agentState
        ? { agentState: agentState.state, stateStartedAtMs: agentState.receivedAt }
        : {})
    })
  }

  orca.commands.register('presence.toggle', async () => {
    await persist({ ...settings, enabled: !settings.enabled })
    await refresh()
    return { enabled: settings.enabled }
  })

  orca.commands.register('presence.detail-level', async () => {
    await persist({ ...settings, detailLevel: nextDetailLevel(settings.detailLevel) })
    await refresh()
    return { detailLevel: settings.detailLevel }
  })

  for (const [commandId, field] of Object.entries(TOGGLE_COMMANDS) as [
    ToggleCommandId,
    (typeof TOGGLE_COMMANDS)[ToggleCommandId]
  ][]) {
    orca.commands.register(commandId, async () => {
      await persist(toggleField(settings, field))
      await refresh()
      return { [field]: settings[field] }
    })
  }

  orca.commands.register('presence.status', async () => {
    const status = controller?.status()
    const summary = `enabled=${status?.enabled} connected=${status?.connected} detail=${status?.detailLevel}`
    orca.log(`${summary} transmitting=${JSON.stringify(status?.lastActivity)}`)
    await orca.host.call('notifications.show', {
      title: 'Discord Rich Presence',
      body: summary
    })
    return status
  })

  orca.events.on('agent.status.changed', async (payload) => {
    await refresh(payload as AgentStatusPayload)
  })
  orca.events.on('worktree.created', async () => {
    await refresh()
  })
  orca.events.on('worktree.removed', async () => {
    await refresh()
  })

  heartbeat = setInterval(() => {
    void refresh()
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  // Why: fire-and-forget. `activate` must resolve inside
  // PLUGIN_WORKER_READY_TIMEOUT_MS (10s) or the host SIGKILLs the worker, and
  // the first refresh chains into a socket scan plus a 5s handshake timeout.
  void refresh()
}

export async function deactivate() {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  await controller?.stop()
  controller = null
}
