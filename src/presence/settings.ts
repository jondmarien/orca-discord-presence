/**
 * Presence settings model: privacy-first defaults, normalize, and toggles.
 *
 * Settings are persisted through the host `settings.*` API, so anything read
 * back may be stale, partial, or hand-edited. Normalize on every read.
 * Unknown keys are dropped; invalid types fall back to
 * {@link DEFAULT_SETTINGS}. The HTTP companion (`bridgeEnabled` / `bridgeUrl`
 * / `bridgeToken`) is opt-in and defaults off.
 *
 * @module presence/settings
 * @author Jonathan Marien
 * @date 2026-09-05
 */

import { inspectApplicationId } from '../discord/app-id'
import { normalizeBridgeToken, normalizeBridgeUrl } from './bridge'

/**
 * Detail-level ladder, in the order **Cycle Detail Level** walks.
 *
 * | Level | What may be transmitted |
 * |---|---|
 * | `off` | Nothing — presence cleared |
 * | `generic` | Non-identifying copy + optional agent / terminals / elapsed |
 * | `workspace` | Workspace display name; still no branch |
 * | `full` | Workspace + optional branch, machine, etc. |
 */
export const DETAIL_LEVELS = ['off', 'generic', 'workspace', 'full'] as const

/**
 * One of {@link DETAIL_LEVELS}.
 */
export type DetailLevel = (typeof DETAIL_LEVELS)[number]

/**
 * Persisted plugin settings. Every identifying field is opt-in except the
 * non-identifying defaults (`enabled`, `generic` detail, agent state, elapsed).
 */
export type PresenceSettings = {
  /** Master switch. When false, activity is cleared regardless of detail. */
  enabled: boolean
  /** Privacy ladder. See {@link DETAIL_LEVELS}. */
  detailLevel: DetailLevel
  /**
   * Discord Application ID (snowflake). Defaults to
   * {@link SHIPPED_APPLICATION_ID}. v0.2 has no user-facing override UI;
   * a 17–20 digit string is still accepted if persisted.
   */
  applicationId: string
  /**
   * Optional display override for the machine name (max 64 trimmed chars).
   * Used only when `showMachine` is on and detail is not `generic`.
   */
  machineLabel: string | null
  /** Include git branch in `details` at `full` when a branch exists. */
  showBranch: boolean
  /** Include the mapped agent-state label in `state`. */
  showAgentState: boolean
  /** Include `N terminal(s)` in `state`. */
  showTerminals: boolean
  /** Include machine name / `machineLabel` in `state` (never at `generic`). */
  showMachine: boolean
  /** Include a Discord elapsed-timer start timestamp. */
  showElapsed: boolean
  /**
   * Opt-in HTTP bridge to a Discord-IPC companion on any OS. Default **off**.
   * When on, the controller may POST the privacy-gated activity if local
   * Discord IPC is unavailable (`src/presence/bridge.ts`).
   */
  bridgeEnabled: boolean
  /**
   * Companion base URL (`http://` / `https://` only), no `/activity` suffix
   * required. Empty when unused.
   */
  bridgeUrl: string
  /**
   * Shared bearer token for the companion. Required when `bridgeUrl` is
   * not loopback. Never logged.
   */
  bridgeToken: string
  /**
   * Structured `orca.log` + on-disk plugin log. Default **on** so connect
   * / SET_ACTIVITY / bridge lines are findable without hunting the UI.
   * Connect failures are always logged even when this is off.
   */
  debugLogging: boolean
}

/**
 * Boolean keys of {@link PresenceSettings} (the fields {@link toggleField} flips).
 */
type BooleanSetting = {
  [K in keyof PresenceSettings]: PresenceSettings[K] extends boolean ? K : never
}[keyof PresenceSettings]

/**
 * Public Discord application id. Not a secret — it rides in every presence
 * payload. The Discord Developer Portal already has this application and the
 * five Rich Presence assets uploaded (`orca`, `state-working`,
 * `state-blocked`, `state-waiting`, `state-idle`).
 */
export const SHIPPED_APPLICATION_ID = '1545653843239374848'

/**
 * Privacy-first defaults applied to every missing or invalid field.
 *
 * `detailLevel: 'generic'` never transmits a repo, branch, or machine name.
 */
export const DEFAULT_SETTINGS: Readonly<PresenceSettings> = Object.freeze({
  enabled: true,
  // 'generic' never transmits a repo, branch, or machine name.
  detailLevel: 'generic',
  applicationId: SHIPPED_APPLICATION_ID,
  machineLabel: null,
  showBranch: false,
  showAgentState: true,
  showTerminals: false,
  showMachine: false,
  showElapsed: true,
  // Cross-machine HTTP is off until the operator opts in.
  bridgeEnabled: false,
  bridgeUrl: '',
  bridgeToken: '',
  // Default on for this debug-friendly release; toggle off via command.
  debugLogging: true
})

const BOOLEAN_FIELDS = (Object.keys(DEFAULT_SETTINGS) as (keyof PresenceSettings)[]).filter(
  (key): key is BooleanSetting => typeof DEFAULT_SETTINGS[key] === 'boolean'
)

function isDetailLevel(value: unknown): value is DetailLevel {
  return typeof value === 'string' && (DETAIL_LEVELS as readonly string[]).includes(value)
}

/**
 * Trim and cap a machine-label override at 64 characters; empty → `null`.
 */
function normalizeLabel(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 64) : null
}

/**
 * Coerce unknown persisted JSON into a complete {@link PresenceSettings}.
 *
 * - Non-objects and missing fields → defaults.
 * - Non-boolean toggles are ignored (default kept).
 * - Unknown `detailLevel` is ignored.
 * - `applicationId` must match {@link APPLICATION_ID_RE} or equal the
 *   shipped id; otherwise the shipped default is used. Absent/malformed
 *   values never become `null` (that would make connect impossible).
 * - Extra keys are not copied onto the result.
 *
 * @param raw - Value from `settings.get` (or `{}` / `undefined`).
 * @returns A fully populated settings object.
 */
export function normalizeSettings(raw: unknown): PresenceSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const settings: PresenceSettings = { ...DEFAULT_SETTINGS }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof source[field] === 'boolean') {
      settings[field] = source[field]
    }
  }
  if (isDetailLevel(source.detailLevel)) {
    settings.detailLevel = source.detailLevel
  }
  // Why: absent or malformed overrides fall back to the shipped id — never to
  // null, which would leave the plugin permanently unable to connect.
  // The shipped snowflake is always accepted. Junk ids are rejected here;
  // activate() logs / optionally toasts when inspectApplicationId used a fallback.
  settings.applicationId = inspectApplicationId(
    source.applicationId,
    SHIPPED_APPLICATION_ID
  ).applicationId
  settings.machineLabel = normalizeLabel(source.machineLabel) ?? DEFAULT_SETTINGS.machineLabel
  settings.bridgeUrl = normalizeBridgeUrl(source.bridgeUrl)
  settings.bridgeToken = normalizeBridgeToken(source.bridgeToken)
  return settings
}

/**
 * Advance one step on the {@link DETAIL_LEVELS} ladder (`full` wraps to `off`).
 *
 * An unknown `current` (index `-1`) yields `DETAIL_LEVELS[0]` (`off`).
 *
 * @param current - Current level string (typically already normalized).
 * @returns The next {@link DetailLevel}.
 */
export function nextDetailLevel(current: string): DetailLevel {
  const index = (DETAIL_LEVELS as readonly string[]).indexOf(current)
  return DETAIL_LEVELS[(index + 1) % DETAIL_LEVELS.length]
}

/**
 * Flip one boolean settings field. Non-boolean or unknown `field` names
 * return the same object unchanged (referential equality).
 *
 * @param settings - Current settings.
 * @param field - A boolean key of {@link PresenceSettings}.
 * @returns A shallow copy with that field inverted, or `settings` unchanged.
 */
export function toggleField(settings: PresenceSettings, field: string): PresenceSettings {
  if (!BOOLEAN_FIELDS.includes(field as BooleanSetting)) {
    return settings
  }
  const key = field as BooleanSetting
  return { ...settings, [key]: !settings[key] }
}
