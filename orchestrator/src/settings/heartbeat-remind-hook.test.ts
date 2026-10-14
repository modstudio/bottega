import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('heartbeat reminder recognizes detached dispatch commands', () => {
  const hookTest = fileURLToPath(new URL('../../hooks/test_heartbeat_remind.py', import.meta.url))
  const result = Bun.spawnSync(['python3', hookTest], { stdout: 'pipe', stderr: 'pipe' })
  expect({
    exitCode: result.exitCode,
    output: result.exitCode === 0 ? 'ok' : `${result.stdout.toString()}${result.stderr.toString()}`,
  }).toEqual({ exitCode: 0, output: 'ok' })
})
