#!/usr/bin/env bun
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const drizzleKit = join(root, 'node_modules', '.bin', 'drizzle-kit')

function run(args: string[]): string {
  const result = Bun.spawnSync([drizzleKit, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()
  if (stdout) console.log(stdout)
  if (stderr) console.error(stderr)
  if (result.exitCode !== 0) process.exit(1)
  return stdout
}

run(['check', '--config', 'shared/record/drizzle.config.ts', '--output', 'json'])
const explained = run([
  'generate',
  '--config',
  'shared/record/drizzle.config.ts',
  '--explain',
  '--output',
  'json',
])

let envelope: unknown
try {
  envelope = JSON.parse(explained)
} catch {
  console.error('drizzle-kit generate --explain did not return a JSON envelope')
  process.exit(1)
}
if (
  envelope === null ||
  typeof envelope !== 'object' ||
  !('status' in envelope) ||
  envelope.status !== 'no_changes'
) {
  console.error('Postgres schema has an ungenerated migration')
  process.exit(1)
}
