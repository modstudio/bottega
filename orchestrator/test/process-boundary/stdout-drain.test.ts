import { expect, test } from 'bun:test'
import { addRun, db, dir } from '../fixture.ts'
import { join } from 'node:path'

const ENTRY = new URL('../../src/orch.ts', import.meta.url).pathname

/**
 * A JSON document larger than a pipe buffer must reach a slow reader whole.
 * Under Bun a bare console.log to a pipe whose reader has not started is cut
 * at 65,536 bytes once node:process is loaded, which Commander does; a shell
 * capture then parses a fragment as the answer. The reader here sleeps before
 * it reads, which is the shape that reproduces the class.
 */
test('a JSON listing larger than the pipe buffer reaches a reader that sleeps before reading', () => {
  for (let i = 0; i < 200; i++) addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const env = { ...process.env, ORCH_DB: db().filename, ORCH_DEPTH: '0' }
  const command = [process.execPath, ENTRY, 'runs', '--limit', '200', '--json']
  const toFile = join(dir, 'runs-to-file.json')
  const direct = Bun.spawnSync(command, { env, stdout: Bun.file(toFile), stderr: 'pipe' })
  expect(direct.exitCode).toBe(0)
  const expected = Bun.file(toFile).size
  expect(expected).toBeGreaterThan(65_536)
  const quoted = command.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(' ')
  const slow = Bun.spawnSync(['sh', '-c', `${quoted} | { sleep 1; cat; }`], { env, stdout: 'pipe', stderr: 'pipe' })
  expect(slow.exitCode).toBe(0)
  expect(slow.stdout.byteLength).toBe(expected)
})
