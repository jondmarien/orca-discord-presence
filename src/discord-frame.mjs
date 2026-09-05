// Discord IPC wire format: [int32LE opcode][int32LE byteLength][utf8 JSON].

export const OPCODE = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 }

// Why: a hostile or desynced stream must not let us buffer unbounded memory.
const MAX_FRAME_BYTES = 1024 * 1024

export function encodeFrame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.allocUnsafe(8 + body.length)
  frame.writeInt32LE(opcode, 0)
  frame.writeInt32LE(body.length, 4)
  body.copy(frame, 8)
  return frame
}

export function createFrameDecoder(onFrame, onError = () => {}) {
  let buffered = Buffer.alloc(0)
  let broken = false
  return {
    push(chunk) {
      if (broken) {
        return
      }
      buffered = Buffer.concat([buffered, chunk])
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
        let parsed
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
