// Settings are persisted through the host `settings.*` API, so anything read
// back may be stale, partial, or hand-edited. Normalize on every read.

export const DETAIL_LEVELS = ['off', 'generic', 'workspace', 'full']

// Public Discord application id. Not a secret — it rides in every presence
// payload. Replace this placeholder with the real snowflake from the Discord
// Developer Portal before shipping; see README.md.
export const SHIPPED_APPLICATION_ID = 'REPLACE_WITH_DISCORD_APPLICATION_ID'

export const DEFAULT_SETTINGS = Object.freeze({
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

const BOOLEAN_FIELDS = Object.keys(DEFAULT_SETTINGS).filter(
  (key) => typeof DEFAULT_SETTINGS[key] === 'boolean'
)

// Discord snowflakes are 17-20 digits today; accept that range and nothing else.
const APPLICATION_ID_RE = /^\d{17,20}$/

function normalizeLabel(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 64) : null
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const settings = { ...DEFAULT_SETTINGS }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof source[field] === 'boolean') {
      settings[field] = source[field]
    }
  }
  if (DETAIL_LEVELS.includes(source.detailLevel)) {
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

export function nextDetailLevel(current) {
  const index = DETAIL_LEVELS.indexOf(current)
  return DETAIL_LEVELS[(index + 1) % DETAIL_LEVELS.length]
}

export function toggleField(settings, field) {
  if (!BOOLEAN_FIELDS.includes(field)) {
    return settings
  }
  return { ...settings, [field]: !settings[field] }
}
