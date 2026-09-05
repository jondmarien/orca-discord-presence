// Discord IPC: socket path discovery + wire framing.
//
// Candidate paths are most-likely first. Platform, env, and uid are injected
// so the table is testable off-platform.
//
// Wire format: [int32LE opcode][int32LE byteLength][utf8 JSON].

const SOCKET_INDEX_LIMIT = 10
// Flatpak and Snap sandbox Discord's runtime dir one level down.
const SANDBOX_SUBDIRS = ['', 'app/com.discordapp.Discord', 'snap.discord'] as const

export const OPCODE = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
} as const

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE]

// Why: a hostile or desynced stream must not let us buffer unbounded memory.
const MAX_FRAME_BYTES = 1024 * 1024

export type IpcPathInput = {
  platform: string
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
  uid?: number
}

function trimTrailingSeparator(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

export function discordIpcCandidates({ platform, env, uid }: IpcPathInput): string[] {
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
    .filter((prefix): prefix is string => typeof prefix === 'string' && prefix.length > 0)
    .map(trimTrailingSeparator)

  const seen = new Set<string>()
  const candidates: string[] = []
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

export function encodeFrame(opcode: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(8 + body.length)
  frame.writeInt32LE(opcode, 0)
  frame.writeInt32LE(body.length, 4)
  body.copy(frame, 8)
  return frame
}

export function createFrameDecoder(
  onFrame: (opcode: number, data: unknown) => void,
  onError: (error: unknown) => void = () => {}
) {
  let buffered = Buffer.alloc(0)
  let broken = false
  return {
    push(chunk: Buffer | Uint8Array | string) {
      if (broken) {
        return
      }
      const next = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
      buffered = Buffer.concat([buffered, next])
      for (;;) {
        if (buffered.length < 8) {
          return
        }
        const opcode = buffered.readInt32LE(0)
        const length = buffered.readInt32LE(4)
        if (length < 0 || length > MAX_FRAME_BYTES) {
          broken = true
          onError(new Error(`discord frame length out of range: ${length}`))
          return
        }
        if (buffered.length < 8 + length) {
          return
        }
        const body = buffered.subarray(8, 8 + length)
        buffered = buffered.subarray(8 + length)
        let parsed: unknown
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch (error) {
          broken = true
          onError(error)
          return
        }
        onFrame(opcode, parsed)
      }
    }
  }
}
