#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'

const falsify = process.argv.includes('--falsify')
const container = `dev-445-postgres-${randomUUID().slice(0, 8)}`

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
    '-e', 'POSTGRES_PASSWORD=postgres', '-d', 'postgres:18-alpine',
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

  process.exitCode = await run(
    ['bun', 'test', '--timeout', '30000', 'src/postgres-rls.test.ts'],
    {
      ORCH_TEST_POSTGRES_CONTAINER: container,
      ORCH_TEST_POSTGRES_FALSIFY: falsify ? 'drop-project-select' : '',
    },
  )
} finally {
  if (started) {
    Bun.spawnSync(['docker', 'stop', container], { stdout: 'ignore', stderr: 'inherit' })
  }
}
