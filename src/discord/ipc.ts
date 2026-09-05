/**
 * Discord IPC: socket path discovery and wire framing.
 *
 * Candidate paths are most-likely first. Platform, env, and uid are injected
 * so the table is testable off-platform.
 *
 * Wire format (little-endian): `[int32 opcode][int32 byteLength][utf8 JSON]`.
 * Opcodes: HANDSHAKE 0, FRAME 1, CLOSE 2, PING 3, PONG 4.
 *
 * @module discord/ipc
 * @author Jonathan Marien
 * @date 2026-09-05
 */

/**
 * Discord exposes `discord-ipc-0` through `discord-ipc-9` per install prefix.
 *
 * @author Jonathan Marien
 */
const SOCKET_INDEX_LIMIT = 10

/**
 * Extra path segments for sandboxed Discord installs. Empty string is the
 * unsandboxed runtime dir (`discord-ipc-N` directly under the prefix).
 *
 * Official Discord Flatpak and Snap nest one level down. Vesktop Flatpak
 * (`dev.vencord.Vesktop`) with arRPC exposes the socket under
 * `.flatpak/dev.vencord.Vesktop/xdg-run` — the host view of the sandbox
 * XDG runtime. There is no Flathub app `dev.vencord.Vencord` (Vencord is
 * a client mod; Vesktop is the standalone client), so that id is omitted.
 *
 * @author Jonathan Marien
 */
const SANDBOX_SUBDIRS = [
  '',
  'app/com.discordapp.Discord',
  'snap.discord',
  '.flatpak/dev.vencord.Vesktop/xdg-run'
] as const

/**
 * Discord IPC opcodes. Handshake uses 0; RPC commands and READY/ERROR
 * dispatches use FRAME (1).
 *
 * @author Jonathan Marien
 */
export const OPCODE = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
} as const

/**
 * Numeric opcode union (`0` | `1` | `2` | `3` | `4`).
 *
 * @author Jonathan Marien
 */
export type Opcode = (typeof OPCODE)[keyof typeof OPCODE]

/**
 * Maximum JSON body size the decoder will accept.
 *
 * Why: a hostile or desynced stream must not let us buffer unbounded memory.
 *
 * @author Jonathan Marien
 */
const MAX_FRAME_BYTES = 1024 * 1024

/**
 * Inputs for {@link discordIpcCandidates}. Injected so tests can simulate
 * Windows pipes and Linux XDG reconstruction without running on those OSes.
 *
 * @author Jonathan Marien
 */
export type IpcPathInput = {
  /** `process.platform` value (`win32`, `linux`, `darwin`, …). */
  platform: string
  /** Environment map; Linux reads `XDG_RUNTIME_DIR`, `TMPDIR`, `TMP`, `TEMP`. */
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
  /**
   * Numeric user id used to rebuild `/run/user/<uid>` when the worker env
   * allowlist has dropped `XDG_RUNTIME_DIR`.
   */
  uid?: number
}

/**
 * Strip trailing `/` or `\` so prefix concatenation does not double separators.
 */
function trimTrailingSeparator(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

/**
 * Build the ordered list of Discord IPC socket / named-pipe paths.
 *
 * Windows: `\\?\pipe\discord-ipc-0` … `discord-ipc-9`.
 * POSIX: for each prefix (`XDG_RUNTIME_DIR`, `/run/user/<uid>`, temp dirs,
 * `/tmp`) and each {@link SANDBOX_SUBDIRS} entry, emit `discord-ipc-0`…`9`.
 * Duplicates are dropped; first occurrence wins.
 *
 * @param input - Platform, env, and optional uid.
 * @returns Deduplicated candidate paths, most-likely first.
 * @author Jonathan Marien
 */
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

/**
 * Encode one Discord IPC frame: 8-byte header plus UTF-8 JSON body.
 *
 * Length is **byte** length of the JSON, not JavaScript string length
 * (multi-byte characters must not be under-counted).
 *
 * @param opcode - {@link OPCODE} value.
 * @param payload - JSON-serializable body (handshake `{ v, client_id }`, RPC command, etc.).
 * @returns A Node `Buffer` ready to `socket.write`.
 * @author Jonathan Marien
 */
export function encodeFrame(opcode: number, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(8 + body.length)
  frame.writeInt32LE(opcode, 0)
  frame.writeInt32LE(body.length, 4)
  body.copy(frame, 8)
  return frame
}

/**
 * Incremental decoder for a Discord IPC byte stream.
 *
 * Call `push` with each socket chunk. Complete frames invoke `onFrame`;
 * malformed JSON or a declared length outside `0…MAX_FRAME_BYTES` invoke
 * `onError` and freeze the decoder (further `push` is ignored). Frames may
 * be split across chunks or packed into one chunk.
 *
 * @param onFrame - Receives opcode and parsed JSON for each complete frame.
 * @param onError - Receives decode errors; default is a no-op.
 * @returns An object with `push(chunk)`.
 * @author Jonathan Marien
 */
export function createFrameDecoder(
  onFrame: (opcode: number, data: unknown) => void,
  onError: (error: unknown) => void = () => {}
) {
  let buffered = Buffer.alloc(0)
  let broken = false
  return {
    /**
     * Append bytes and emit any complete frames.
     *
     * @param chunk - Socket data (`Buffer`, `Uint8Array`, or string).
     */
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
