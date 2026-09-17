import { createConnection } from 'node:net'

const value = process.env.ORCH_ASK_URL
if (!value) throw new Error('ORCH_ASK_URL is required')
const url = new URL(value)
if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !url.port) {
  throw new Error('ORCH_ASK_URL must name a tcp://127.0.0.1:<port> endpoint')
}

const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) })
await new Promise<void>((resolve, reject) => {
  socket.once('connect', resolve)
  socket.once('error', reject)
})
process.stdin.pipe(socket)
socket.pipe(process.stdout)
await new Promise<void>((resolve, reject) => {
  socket.once('close', resolve)
  socket.once('error', reject)
})
