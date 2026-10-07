import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { BOARD_HOSTED_ADOPTED_KEY, boardMode, boardModeForId } from './board-mode.ts'

function memoryBoard(): Database {
  const database = new Database(':memory:')
  database.run('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return database
}

test('an adopted board is hosted when only a configured file provides the endpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'board-mode-url-'))
  const database = memoryBoard()
  try {
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

test('a machine-local operation does not read an unavailable environment file', () => {
  const database = memoryBoard()
  try {
    expect(
      boardMode('machine-audience', { [HARNESS_ENV_FILE_ENV]: '/dev/null/unavailable' }, database),
    ).toBe('local')
  } finally {
    database.close()
  }
})

test('an invalid id is refused without reading an unavailable environment file', () => {
  const database = memoryBoard()
  try {
    expect(() =>
      boardModeForId(
        'not-an-id',
        'message',
        { [HARNESS_ENV_FILE_ENV]: '/dev/null/unavailable' },
        database,
      ),
    ).toThrow('message must be either a positive integer string')
  } finally {
    database.close()
  }
})

test('a hosted id on an unadopted install does not read an unavailable environment file', () => {
  const database = memoryBoard()
  try {
    expect(() =>
      boardModeForId(
        '01990000-0000-7000-8000-000000000001',
        'message',
        { [HARNESS_ENV_FILE_ENV]: '/dev/null/unavailable' },
        database,
      ),
    ).toThrow('this install has not adopted the hosted board')
  } finally {
    database.close()
  }
})

test('a hosted id on an adopted install reports an unavailable environment file', () => {
  const database = memoryBoard()
  try {
    database
      .query('INSERT INTO schema_meta (key, value) VALUES (?, ?)')
      .run(BOARD_HOSTED_ADOPTED_KEY, '1')
    expect(() =>
      boardModeForId(
        '01990000-0000-7000-8000-000000000001',
        'message',
        {
          [CONFIG_HOME_ENV]: '/tmp/dev-1144-unavailable-config',
          [HARNESS_ENV_FILE_ENV]: '/dev/null/unavailable',
        },
        database,
      ),
    ).toThrow('cannot read environment file /dev/null/unavailable')
  } finally {
    database.close()
  }
})
