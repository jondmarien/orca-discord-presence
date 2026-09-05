// Candidate Discord IPC socket paths, most-likely first. Pure: platform, env,
// and uid are injected so the table is testable off-platform.

const SOCKET_INDEX_LIMIT = 10
// Flatpak and Snap sandbox Discord's runtime dir one level down.
const SANDBOX_SUBDIRS = ['', 'app/com.discordapp.Discord', 'snap.discord']

function trimTrailingSeparator(value) {
  return value.replace(/[\\/]+$/, '')
}

export function discordIpcCandidates({ platform, env, uid }) {
  if (platform === 'win32') {
    return Array.from(
      { length: SOCKET_INDEX_LIMIT },
      (_unused, index) => `\\\\?\\pipe\\discord-ipc-${index}`
    )
  }
  // Why: the plugin worker env allowlist drops XDG_RUNTIME_DIR, so the
  // conventional Linux location has to be rebuilt from the uid.
  const prefixes = [
    env.XDG_RUNTIME_DIR,
    typeof uid === 'number' ? `/run/user/${uid}` : undefined,
    env.TMPDIR,
    env.TMP,
    env.TEMP,
    '/tmp'
  ]
    .filter((prefix) => typeof prefix === 'string' && prefix.length > 0)
    .map(trimTrailingSeparator)

  const seen = new Set()
  const candidates = []
  for (const prefix of prefixes) {
    for (const subdir of SANDBOX_SUBDIRS) {
      const base = subdir ? `${prefix}/${subdir}` : prefix
      for (let index = 0; index < SOCKET_INDEX_LIMIT; index++) {
        const candidate = `${base}/discord-ipc-${index}`
        if (!seen.has(candidate)) {
          seen.add(candidate)
          candidates.push(candidate)
        }
      }
    }
  }
  return candidates
}
