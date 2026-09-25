import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('session-brief context assembly drops lower-priority sections under the hook budget', () => {
  const hookTest = fileURLToPath(
    new URL('../../hooks/test_session_brief_context.py', import.meta.url),
  )
  const result = Bun.spawnSync(['python3', hookTest], { stdout: 'pipe', stderr: 'pipe' })
  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.exitCode === 0 ? 'ok' : result.stdout.toString(),
  }).toEqual({ exitCode: 0, stderr: '', stdout: 'ok' })
})
