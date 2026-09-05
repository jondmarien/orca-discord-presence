// Settings are persisted through the host `settings.*` API, so anything read
// back may be stale, partial, or hand-edited. Normalize on every read.

export const DETAIL_LEVELS = ['off', 'generic', 'workspace', 'full'] as const

export type DetailLevel = (typeof DETAIL_LEVELS)[number]

export type PresenceSettings = {
  enabled: boolean
  detailLevel: DetailLevel
  applicationId: string
  machineLabel: string | null
  showBranch: boolean
  showAgentState: boolean
  showTerminals: boolean
  showMachine: boolean
  showElapsed: boolean
}

type BooleanSetting = {
  [K in keyof PresenceSettings]: PresenceSettings[K] extends boolean ? K : never
}[keyof PresenceSettings]

// Public Discord application id. Not a secret — it rides in every presence
// payload. The Discord Developer Portal already has this application and the
// five Rich Presence assets uploaded.
export const SHIPPED_APPLICATION_ID = '1545653843239374848'

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
  showElapsed: true
})

const BOOLEAN_FIELDS = (Object.keys(DEFAULT_SETTINGS) as (keyof PresenceSettings)[]).filter(
  (key): key is BooleanSetting => typeof DEFAULT_SETTINGS[key] === 'boolean'
)

// Discord snowflakes are 17-20 digits today; accept that range and nothing else.
const APPLICATION_ID_RE = /^\d{17,20}$/

function isDetailLevel(value: unknown): value is DetailLevel {
  return typeof value === 'string' && (DETAIL_LEVELS as readonly string[]).includes(value)
}

function normalizeLabel(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 64) : null
}

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
  // The shipped placeholder is also accepted so persisted defaults round-trip.
  if (typeof source.applicationId === 'string') {
    const trimmed = source.applicationId.trim()
    if (APPLICATION_ID_RE.test(trimmed) || trimmed === SHIPPED_APPLICATION_ID) {
      settings.applicationId = trimmed
    } else {
      settings.applicationId = DEFAULT_SETTINGS.applicationId
    }
  } else {
    settings.applicationId = DEFAULT_SETTINGS.applicationId
  }
  settings.machineLabel = normalizeLabel(source.machineLabel) ?? DEFAULT_SETTINGS.machineLabel
  return settings
}

export function nextDetailLevel(current: string): DetailLevel {
  const index = (DETAIL_LEVELS as readonly string[]).indexOf(current)
  return DETAIL_LEVELS[(index + 1) % DETAIL_LEVELS.length]
}

export function toggleField(settings: PresenceSettings, field: string): PresenceSettings {
  if (!BOOLEAN_FIELDS.includes(field as BooleanSetting)) {
    return settings
  }
  const key = field as BooleanSetting
  return { ...settings, [key]: !settings[key] }
}
