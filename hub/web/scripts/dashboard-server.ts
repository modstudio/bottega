import { startBounded } from '../../../shared/bounded-process.ts'
import { hostedApiFetch } from '../../../shared/bounded-fetch.ts'
// concern: dashboard-server
/** Starts, awaits and stops the dashboard server the browser scripts drive. */
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
export const executable = join(repoRoot, 'bin', PLATFORM_SLUG)
export const distribution = join(repoRoot, 'hub', 'web', 'dist', 'index.html')

type Environment = Record<string, string | undefined>

/** The dashboard subprocess configures both output channels as pipes. */
export const pipedOutput = (stream: Bun.Subprocess['stdout']): ReadableStream<Uint8Array> =>
  stream as ReadableStream<Uint8Array>

export async function command(args: string[], env: Environment): Promise<string> {
  const child = await startBounded([executable, ...args], { budget: 'self-cli', cwd: repoRoot, env })
  const { stdout, stderr, exitCode } = child
  if (exitCode !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    )
  }
  return stdout.trim()
}

export async function freePort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const address = reservation.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  )
  if (port === undefined) throw new Error('could not reserve a dashboard server port')
  return port
}

export async function waitForServer(origin: string, exited: Promise<number>): Promise<void> {
  let lastFailure = 'no response'
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await hostedApiFetch(origin)
      return
    } catch (error) {
      lastFailure = String(error)
    }
    const result = await Promise.race([
      exited.then((exitCode) => ({ exitCode })),
      Bun.sleep(50).then(() => null),
    ])
    if (result)
      throw new Error(`dashboard server exited ${result.exitCode} before accepting requests`)
  }
  throw new Error(`dashboard server did not accept requests: ${lastFailure}`)
}

export async function stopServer(server: ReturnType<typeof Bun.spawn>): Promise<void> {
  server.kill()
  const stopped = await Promise.race([
    server.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ])
  if (!stopped) {
    server.kill(9)
    await server.exited
  }
}
