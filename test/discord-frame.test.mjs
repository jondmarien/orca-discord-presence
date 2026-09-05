import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPCODE, encodeFrame, createFrameDecoder } from '../src/discord-frame.mjs'

test('encodes opcode and byte length in little-endian header', () => {
  const frame = encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: '123' })
  const body = JSON.stringify({ v: 1, client_id: '123' })
  assert.equal(frame.readInt32LE(0), 0)
  assert.equal(frame.readInt32LE(4), Buffer.byteLength(body))
  assert.equal(frame.subarray(8).toString('utf8'), body)
})

test('length is byte length, not character length', () => {
  const frame = encodeFrame(OPCODE.FRAME, { state: 'héllo — ok' })
  const declared = frame.readInt32LE(4)
  assert.equal(declared, frame.length - 8)
  assert.notEqual(declared, JSON.stringify({ state: 'héllo — ok' }).length)
})

test('decoder reassembles a frame split across chunk boundaries', () => {
  const frames = []
  const decoder = createFrameDecoder((op, data) => frames.push({ op, data }))
  const whole = encodeFrame(OPCODE.FRAME, { cmd: 'DISPATCH', evt: 'READY' })
  decoder.push(whole.subarray(0, 3))
  decoder.push(whole.subarray(3, 10))
  decoder.push(whole.subarray(10))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].op, OPCODE.FRAME)
  assert.equal(frames[0].data.evt, 'READY')
})

test('decoder emits multiple frames arriving in one chunk', () => {
  const frames = []
  const decoder = createFrameDecoder((op, data) => frames.push({ op, data }))
  decoder.push(
    Buffer.concat([encodeFrame(OPCODE.PING, { n: 1 }), encodeFrame(OPCODE.PONG, { n: 2 })])
  )
  assert.deepEqual(
    frames.map((frame) => frame.op),
    [OPCODE.PING, OPCODE.PONG]
  )
})

test('malformed json surfaces as an error, not a throw', () => {
  const errors = []
  const decoder = createFrameDecoder(
    () => assert.fail('should not emit'),
    (error) => errors.push(error)
  )
  const header = Buffer.alloc(8)
  header.writeInt32LE(OPCODE.FRAME, 0)
  header.writeInt32LE(3, 4)
  decoder.push(Buffer.concat([header, Buffer.from('{ x', 'utf8')]))
  assert.equal(errors.length, 1)
})

test('an absurd declared length is rejected instead of buffering forever', () => {
  const errors = []
  const decoder = createFrameDecoder(
    () => assert.fail('should not emit'),
    (error) => errors.push(error)
  )
  const header = Buffer.alloc(8)
  header.writeInt32LE(OPCODE.FRAME, 0)
  header.writeInt32LE(64 * 1024 * 1024, 4)
  decoder.push(header)
  assert.equal(errors.length, 1)
})
