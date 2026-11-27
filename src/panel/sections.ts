/**
 * Panel section metadata, shared constants, and domain label maps.
 *
 * Imports section/order/detail ids directly from `src/presence/panel-constants`
 * so the worker settings schema and panel UI cannot drift.
 *
 * @module panel/sections
 * @author Jonathan Marien
 * @date 2026-11-26
 */

import {
  DETAIL_LEVELS,
  HIDDEN_PANEL_IDS,
  PANEL_ORDER_IDS,
  type DetailLevel,
  type PanelSectionId
} from '../presence/panel-constants'

export const REQUEST_TIMEOUT_MS = 5000
export const TIMELINE_CELLS = 30
export const SETTINGS_MIRROR_DELAY_MS = 400

export const STATES = ['working', 'waiting', 'blocked', 'completed', 'idle'] as const
export type PanelState = (typeof STATES)[number]

export const STATE_ASSET_RE = /^state-(working|waiting|blocked|completed|idle)$/

export const STATE_FILES: Record<PanelState, string> = {
  working: 'state-working',
  waiting: 'state-waiting',
  blocked: 'state-blocked',
  completed: 'orca-completed',
  idle: 'state-idle'
}

const DETAIL_LABELS: Record<DetailLevel, string> = {
  off: 'Off',
  generic: 'Generic',
  workspace: 'Workspace',
  full: 'Full'
}

export const DETAIL_LEVEL_ENTRIES: ReadonlyArray<readonly [DetailLevel, string]> = DETAIL_LEVELS.map(
  (level) => [level, DETAIL_LABELS[level]] as const
)

export type PanelSectionDef = readonly [PanelSectionId, string, string]

const SECTION_META: Record<PanelSectionId, readonly [string, string]> = {
  preview: ['preview-card', 'Discord preview'],
  strip: ['strip-card', 'Last 30 min'],
  tiles: ['tile-agents-card', 'Agents tile'],
  sink: ['tile-sink-card', 'Sending to'],
  client: ['client-card', 'Discord client'],
  detail: ['detail-card', 'Detail level'],
  agents: ['agents-card', 'Agents'],
  toggles: ['toggles-card', 'Show on Discord'],
  actions: ['actions-row', 'Actions'],
  leaderboards: ['leaderboards-card', 'Leaderboards'],
  logs: ['logs-box', 'Logs']
}

/** Hideable sections in canonical `HIDDEN_PANEL_IDS` order: `[id, elementId, label]`. */
export const PANEL_SECTIONS: readonly PanelSectionDef[] = HIDDEN_PANEL_IDS.map(
  (id) => [id, SECTION_META[id][0], SECTION_META[id][1]] as const
)

export const SECTION_BY_ID: Record<PanelSectionId, PanelSectionDef> = Object.fromEntries(
  PANEL_SECTIONS.map((entry) => [entry[0], entry])
) as Record<PanelSectionId, PanelSectionDef>

export const DEFAULT_BLOCK_ORDER: readonly PanelSectionId[] = PANEL_ORDER_IDS

export const MINIMAL_SECTIONS: readonly PanelSectionId[] = ['strip', 'detail']

export const SWITCH_FIELDS = [
  'showAgentState',
  'showAgentCount',
  'showElapsed',
  'showProject',
  'showBranch',
  'showTerminals',
  'showMachine'
] as const

export const CLIENT_FAMILY_NAMES: Record<string, string> = {
  vesktop: 'Vesktop',
  'discord-flatpak': 'Discord (Flatpak)',
  'discord-snap': 'Discord (Snap)',
  discord: 'Discord'
}

export const HOST_LABELS: Record<string, string> = {
  local: 'Local',
  ssh: 'SSH',
  wsl: 'WSL/VM'
}
