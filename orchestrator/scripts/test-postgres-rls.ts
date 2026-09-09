#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainCheckoutOf } from '../../shared/git.ts'

const falsify = process.argv.includes('--falsify')
const container = `dev-445-postgres-${randomUUID().slice(0, 8)}`
const sourceCopies = mkdtempSync(join(tmpdir(), 'dev-429-sources-'))
const mainCheckout = mainCheckoutOf(new URL('..', import.meta.url).pathname)
if (!mainCheckout) throw new Error('could not locate the main checkout for live database copies')
const sourceOrchDb = join(sourceCopies, 'orch.db')
const sourceHubDb = join(sourceCopies, 'hub.db')
function copyDatabase(source: string, target: string): void {
  copyFileSync(source, target)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${target}${suffix}`)
  }
}
copyDatabase(join(mainCheckout, 'orchestrator', 'orch.db'), sourceOrchDb)
copyDatabase(join(mainCheckout, 'hub', 'hub.db'), sourceHubDb)

async function run(argv: string[], env?: Record<string, string>): Promise<number> {
  const child = Bun.spawn(argv, {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
  return child.exited
}

let started = false
try {
  const start = await run([
    'docker', 'run', '--rm', '--name', container,
    '-e', 'POSTGRES_PASSWORD=postgres', '-p', '127.0.0.1::5432', '-d', 'postgres:18-alpine',
  ])
  if (start !== 0) process.exit(start)
  started = true

  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = Bun.spawnSync(['docker', 'exec', container, 'pg_isready', '-U', 'postgres'], {
      stdout: 'ignore', stderr: 'ignore',
    })
    if (probe.exitCode === 0) { ready = true; break }
    await Bun.sleep(250)
  }
  if (!ready) throw new Error('disposable Postgres did not become ready')

  const portResult = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  if (portResult.exitCode !== 0) throw new Error(portResult.stderr.toString())
  const port = portResult.stdout.toString().trim().split(':').at(-1)
  if (!port) throw new Error('disposable Postgres published no host port')

  const rls = await run(
    ['bun', 'test', '--timeout', '30000', 'src/postgres-rls.test.ts'],
    {
      ORCH_TEST_POSTGRES_CONTAINER: container,
      ORCH_TEST_POSTGRES_FALSIFY: falsify ? 'drop-project-select' : '',
    },
  )
  if (rls !== 0) process.exitCode = rls
  else if (!falsify) {
    process.exitCode = await run(
      ['bun', 'test', '--timeout', '30000', 'src/postgres-import.test.ts'],
      {
        ORCH_TEST_POSTGRES_CONTAINER: container,
        ORCH_TEST_POSTGRES_URL: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
        ORCH_TEST_SOURCE_ORCH_DB: sourceOrchDb,
        ORCH_TEST_SOURCE_HUB_DB: sourceHubDb,
      },
    )
  }
} finally {
  if (started) {
    Bun.spawnSync(['docker', 'stop', container], { stdout: 'ignore', stderr: 'inherit' })
  }
  rmSync(sourceCopies, { recursive: true, force: true })
}
