import { createConnection } from 'node:net'
import { writeAskServerFailure } from './ask-failure.ts'

export async function main(_argv: string[] = []): Promise<number> {
  const value = process.env.BOTTEGA_ASK_URL
  if (!value) throw new Error('BOTTEGA_ASK_URL is required')
  const url = new URL(value)
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
  return 0
}

export async function runAskProxy(argv: string[] = []): Promise<number> {
  try {
    return await main(argv)
  } catch (error) {
    writeAskServerFailure(error)
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runAskProxy()
}
