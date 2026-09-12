import { expect, test } from 'bun:test'
import { addRun, db, dir } from '../fixture.ts'
import { join } from 'node:path'

const ENTRY = new URL('../../src/orch.ts', import.meta.url).pathname

/**
 * A JSON document larger than a pipe buffer must reach a slow reader whole.
 * Under Bun, once node:process is loaded (Commander loads it), a bare
 * console.log to a pipe delivers only what the pipe had accepted by the time
 * the writer moved on: one 65,536-byte buffer for a reader that sleeps first,
 * ten for a shell capture that was merely slower than the writer (measured
 * 655,360 of 667,467). The cut is not a threshold, so the payload here clears
 * both measurements, and the reader sleeps before it reads.
 */
test('a JSON listing larger than the pipe buffer reaches a reader that sleeps before reading', () => {
  for (let i = 0; i < 1000; i++) addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const env = { ...process.env, ORCH_DB: db().filename, ORCH_DEPTH: '0' }
  const command = [process.execPath, ENTRY, 'runs', '--limit', '1000', '--json']
  const toFile = join(dir, 'runs-to-file.json')
  const direct = Bun.spawnSync(command, { env, stdout: Bun.file(toFile), stderr: 'pipe' })
  expect(direct.exitCode).toBe(0)
  const expected = Bun.file(toFile).size
  expect(expected).toBeGreaterThan(700_000)
  const quoted = command.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ')
  const slow = Bun.spawnSync(['sh', '-c', `${quoted} | { sleep 1; cat; }`], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(slow.exitCode).toBe(0)
  expect(slow.stdout.byteLength).toBe(expected)
})
