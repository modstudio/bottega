import { createServer } from 'node:net'
import { boundedFetch } from '../shared/bounded-fetch.ts'
import { startBounded, startBoundedSync } from '../shared/bounded-process.ts'

const sleepCommand = ['sh', '-c', 'sleep 100 & sleep 100'] as const

function sleepPids(): Set<string> {
  const result = startBoundedSync(['pgrep', '-f', 'sleep 100'], { budget: 'process-table' })
  return new Set(result.stdout.trim().split('\n').filter(Boolean))
}

async function report(name: string, operation: () => Promise<unknown>): Promise<void> {
  const started = performance.now()
  try {
    await operation()
    console.log(`${name}: unexpectedly completed in ${Math.round(performance.now() - started)}ms`)
  } catch (error) {
    console.log(
      `${name}: ${error instanceof Error ? error.message : String(error)}; elapsed ${Math.round(performance.now() - started)}ms`,
    )
  }
}

async function freePort(): Promise<number> {
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
  if (port === undefined) throw new Error('could not reserve a probe port')
  return port
}

const before = sleepPids()
await report('async deadline', async () => startBounded(sleepCommand, { budget: 'process-table' }))
const afterAsync = sleepPids()
console.log(
  `async survivors: ${[...afterAsync].filter((pid) => !before.has(pid)).join(', ') || 'none'}`,
)

const syncStarted = performance.now()
try {
  startBoundedSync(sleepCommand, { budget: 'process-table' })
  console.log(
    `sync deadline: unexpectedly completed in ${Math.round(performance.now() - syncStarted)}ms`,
  )
} catch (error) {
  console.log(
    `sync deadline: ${error instanceof Error ? error.message : String(error)}; elapsed ${Math.round(performance.now() - syncStarted)}ms`,
  )
}
const afterSync = sleepPids()
console.log(
  `sync survivors: ${[...afterSync].filter((pid) => !before.has(pid)).join(', ') || 'none'}`,
)

const stdinStarted = performance.now()
const stdinReader = await startBounded(['cat'], { budget: 'process-table' })
console.log(
  `closed stdin: exit ${stdinReader.exitCode}; elapsed ${Math.round(performance.now() - stdinStarted)}ms`,
)

await report('output flood', async () =>
  startBounded(['sh', '-c', 'while :; do printf 1234567890; done'], {
    budget: 'process-table',
  }),
)

const server = Bun.serve({
  port: await freePort(),
  routes: {
    '/silent': async () => new Promise<Response>(() => {}),
    '/large': new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
  },
})
const fetchWithBounds = boundedFetch('process-table')
try {
  await report('HTTP total timeout', async () => fetchWithBounds(`${server.url}silent`))
  await report('HTTP oversized body', async () => fetchWithBounds(`${server.url}large`))
} finally {
  server.stop(true)
}
