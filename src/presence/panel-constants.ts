/**
 * Browser-safe shared constants for the presence settings model and sidebar panel.
 *
 * Kept free of Node/bridge imports so the browser panel bundle can import them
 * directly without pulling transport or URL-scheme code into `panel/index.html`.
 *
 * @module presence/panel-constants
 * @author Jonathan Marien
 * @date 2026-11-26
 */

/**
 * Detail-level ladder, in the order **Cycle Detail Level** walks.
 */
export const DETAIL_LEVELS = ['off', 'generic', 'workspace', 'full'] as const

/** One of {@link DETAIL_LEVELS}. */
export type DetailLevel = (typeof DETAIL_LEVELS)[number]

/**
 * What the Discord elapsed timer counts: time in Orca this `session`, or time
 * in the current agent `state`.
 */
export const ELAPSED_MODES = ['session', 'state'] as const

/** One of {@link ELAPSED_MODES}. */
export type ElapsedMode = (typeof ELAPSED_MODES)[number]

/**
 * Optional local agent session stats included in Discord Rich Presence.
 */
export const SESSION_STATS_MODES = ['off', 'tokens', 'messages', 'both'] as const

/** One of {@link SESSION_STATS_MODES}. */
export type SessionStatsMode = (typeof SESSION_STATS_MODES)[number]

/**
 * Panel sections the user may hide, in canonical order.
 */
export const HIDDEN_PANEL_IDS = [
  'preview',
  'strip',
  'tiles',
  'sink',
  'client',
  'detail',
  'agents',
  'toggles',
  'actions',
  'leaderboards',
  'logs'
] as const

export type PanelSectionId = (typeof HIDDEN_PANEL_IDS)[number]

/**
 * Default top-to-bottom order of reorderable panel blocks.
 */
export const PANEL_ORDER_IDS: readonly PanelSectionId[] = [
  'actions',
  'preview',
  'strip',
  'tiles',
  'sink',
  'client',
  'detail',
  'agents',
  'toggles',
  'leaderboards',
  'logs'
] as const
