import { createConnection } from 'node:net'
import { writeAskServerFailure } from './ask-failure.ts'

export function recordAskProxyFailure(error: unknown, scratchDir?: string): unknown {
  writeAskServerFailure(error, scratchDir)
  return error
}

export async function main(_argv: string[] = []): Promise<number> {
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
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    throw recordAskProxyFailure(error)
  }
}
