import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { db } from './db.ts'
import { RUNS_DIR } from './run-artifacts.ts'

test('a detached run has exactly one prompt file', async () => {
  const { detach } = await import('./run-dispatch.ts')
  const prior = process.env.ORCH_EXEC_PATH; process.env.ORCH_EXEC_PATH = '/usr/bin/true'
  process.env.ORCH_DEPTH = '0'; process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  try {
    const before = new Set(readdirSync(RUNS_DIR))
    const id = await detach('file-question', 'one exact prompt', {})
    const row = db().query('SELECT prompt_path,prompt_sha FROM run WHERE id=?').get(id) as { prompt_path: string; prompt_sha: string }
    expect(readFileSync(row.prompt_path, 'utf8')).toBe('one exact prompt')
    expect(readdirSync(RUNS_DIR).filter((file) => !before.has(file) && file.endsWith('.prompt.txt'))).toHaveLength(1)
  } finally {
    if (prior === undefined) delete process.env.ORCH_EXEC_PATH; else process.env.ORCH_EXEC_PATH = prior
  }
})
