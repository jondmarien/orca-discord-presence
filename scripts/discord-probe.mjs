// Discord IPC probe: checks every discord-ipc pipe/socket outside Orca.
// Usage: bun scripts/discord-probe.mjs   (any OS; Discord must be running)
// Prints per pipe: connect, READY time, SET_ACTIVITY reply time. Clears the test activity after.
import net from 'node:net'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
// Same candidate list the plugin uses: Linux runtime dirs, Flatpak/Snap sandboxes, ORCA_PRESENCE_DISCORD_IPC.
import { defaultDiscordIpcCandidates } from '../src/discord/ipc.ts'

const CLIENT_ID = '1545653843239374848'
const TIMEOUT_MS = 10_000


function frame(op, body) {
  const json = Buffer.from(JSON.stringify(body))
  const buf = Buffer.alloc(8 + json.length)
  buf.writeInt32LE(op, 0)
  buf.writeInt32LE(json.length, 4)
  json.copy(buf, 8)
  return buf
}

function probe(pipe) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const out = { pipe: pipe.replace(os.homedir(), '~') }
    const socket = net.createConnection(pipe)
    let buf = Buffer.alloc(0)
    const waiters = new Map()
    const done = (extra) => {
      clearTimeout(timer)
      socket.destroy()
      resolve({ ...out, ...extra })
    }
    const timer = setTimeout(() => done({ result: 'TIMEOUT', stage: out.ready ? 'SET_ACTIVITY' : 'READY' }), TIMEOUT_MS)
    const send = (cmd, args) =>
      new Promise((res) => {
        const nonce = randomUUID()
        waiters.set(nonce, res)
        socket.write(frame(1, { cmd, args, nonce }))
      })
    socket.on('error', (e) => done({ result: `no pipe (${e.code})` }))
    socket.on('close', () => done({ result: 'CLOSED by peer', stage: out.ready ? 'after READY' : 'before READY' }))
    socket.on('connect', () => socket.write(frame(0, { v: 1, client_id: CLIENT_ID })))
    socket.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 8 && buf.length >= 8 + buf.readInt32LE(4)) {
        const op = buf.readInt32LE(0)
        const msg = JSON.parse(buf.subarray(8, 8 + buf.readInt32LE(4)).toString())
        buf = buf.subarray(8 + buf.readInt32LE(4))
        if (op === 2) return done({ result: `CLOSE frame: ${msg.code} ${msg.message}` })
        if (msg.evt === 'READY') {
          out.ready = `${Date.now() - t0}ms`
          out.readyHasUser = Boolean(msg.data?.user)
          const t1 = Date.now()
          const reply = await send('SET_ACTIVITY', {
            pid: process.pid,
            activity: { details: 'IPC probe', timestamps: { start: Math.floor(Date.now() / 1000) } }
          })
          out.setActivity = `${Date.now() - t1}ms ${reply.evt === 'ERROR' ? `ERROR ${reply.data?.message}` : 'ok'}`
          await new Promise((r) => setTimeout(r, 3000))
          await send('SET_ACTIVITY', { pid: process.pid, activity: null })
          return done({ result: 'OK' })
        }
        const waiter = msg.nonce && waiters.get(msg.nonce)
        if (waiter) {
          waiters.delete(msg.nonce)
          waiter(msg)
        }
      }
    })
  })
}

for (const pipe of defaultDiscordIpcCandidates()) {
  const result = await probe(pipe)
  if (!result.result.startsWith('no pipe')) console.log(JSON.stringify(result))
}
console.log('done')
