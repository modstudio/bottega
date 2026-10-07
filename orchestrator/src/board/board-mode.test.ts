import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { BOARD_HOSTED_ADOPTED_KEY, boardMode } from './board-mode.ts'

test('an adopted board is hosted when only a configured file provides the endpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-mode-url-'))
  const database = new Database(':memory:')
  try {
    database.run('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    database
      .query('INSERT INTO schema_meta (key, value) VALUES (?, ?)')
      .run(BOARD_HOSTED_ADOPTED_KEY, '1')
    const config = join(root, 'config')
    const harness = join(root, 'harness.env')
    mkdirSync(config)
    writeFileSync(harness, 'ORCH_RECORD_API_URL=https://file.example.test\n')

    expect(
      boardMode('shared', { [CONFIG_HOME_ENV]: config, [HARNESS_ENV_FILE_ENV]: harness }, database),
    ).toBe('hosted')
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
