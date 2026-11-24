import { createConnection } from 'node:net'

/** Forward stdio to the database-owning ask loopback. */
export async function connectAskLoopback(urlValue: string): Promise<void> {
  const url = new URL(urlValue)
  if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('BOTTEGA_ASK_URL must name a tcp://127.0.0.1:<port> endpoint')
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
}
