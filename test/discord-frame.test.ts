import { expect, test } from 'bun:test'
import { createFrameDecoder, encodeFrame, OPCODE } from '../src/discord/ipc'

test('encodes opcode and byte length in little-endian header', () => {
  const frame = encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: '123' })
  const body = JSON.stringify({ v: 1, client_id: '123' })
  expect(frame.readInt32LE(0)).toBe(0)
  expect(frame.readInt32LE(4)).toBe(Buffer.byteLength(body))
  expect(frame.subarray(8).toString('utf8')).toBe(body)
})

test('length is byte length, not character length', () => {
  const frame = encodeFrame(OPCODE.FRAME, { state: 'héllo — ok' })
  const declared = frame.readInt32LE(4)
  expect(declared).toBe(frame.length - 8)
  expect(declared).not.toBe(JSON.stringify({ state: 'héllo — ok' }).length)
})

test('decoder reassembles a frame split across chunk boundaries', () => {
  const frames: { op: number; data: { evt?: string } }[] = []
  const decoder = createFrameDecoder((op, data) =>
    frames.push({ op, data: data as { evt?: string } })
  )
  const whole = encodeFrame(OPCODE.FRAME, { cmd: 'DISPATCH', evt: 'READY' })
  decoder.push(whole.subarray(0, 3))
  decoder.push(whole.subarray(3, 10))
  decoder.push(whole.subarray(10))
  expect(frames.length).toBe(1)
  expect(frames[0]?.op).toBe(OPCODE.FRAME)
  expect(frames[0]?.data.evt).toBe('READY')
})

test('decoder emits multiple frames arriving in one chunk', () => {
  const frames: { op: number; data: unknown }[] = []
  const decoder = createFrameDecoder((op, data) => frames.push({ op, data }))
  decoder.push(
    Buffer.concat([encodeFrame(OPCODE.PING, { n: 1 }), encodeFrame(OPCODE.PONG, { n: 2 })])
  )
  expect(frames.map((frame) => frame.op)).toEqual([OPCODE.PING, OPCODE.PONG])
})

test('malformed json surfaces as an error, not a throw', () => {
  const errors: unknown[] = []
  const decoder = createFrameDecoder(() => {
    throw new Error('should not emit')
  }, (error) => errors.push(error))
  const header = Buffer.alloc(8)
  header.writeInt32LE(OPCODE.FRAME, 0)
  header.writeInt32LE(3, 4)
  decoder.push(Buffer.concat([header, Buffer.from('{ x', 'utf8')]))
  expect(errors.length).toBe(1)
})

test('an absurd declared length is rejected instead of buffering forever', () => {
  const errors: unknown[] = []
  const decoder = createFrameDecoder(() => {
    throw new Error('should not emit')
  }, (error) => errors.push(error))
  const header = Buffer.alloc(8)
  header.writeInt32LE(OPCODE.FRAME, 0)
  header.writeInt32LE(64 * 1024 * 1024, 4)
  decoder.push(header)
  expect(errors.length).toBe(1)
})
