import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../../shared/config-directory.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { ingestGit } from './ingest/git.ts'
import { rollUpDays } from './query.ts'

beforeEach(resetFixtureStore)

test('rolling intervals into an existing date keeps its UUID', () => {
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO day (record_id,day,collected_at) VALUES (?,?,?)`)
      .run('11111111-1111-4111-8111-111111111111', '2026-10-08', '2026-10-08T12:00:00.000Z')
    conn
      .query(
        `INSERT INTO interval
          (record_id,source,start_at,end_at,claude_tokens,ref)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        '22222222-2222-4222-8222-222222222222',
        'claude',
        '2026-10-08T10:00:00.000Z',
        '2026-10-08T10:01:00.000Z',
        42,
        'claude:fixture:0',
      )
  })

  expect(rollUpDays()).toBe(1)
  expect(
    db()
      .query<{ record_id: string; claude_tokens: number }, []>(
        `SELECT record_id,claude_tokens FROM day WHERE day='2026-10-08'`,
      )
      .get(),
  ).toEqual({
    record_id: '11111111-1111-4111-8111-111111111111',
    claude_tokens: 42,
  })
})

test('day writers refuse to mint a missing machine identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-day-machine-'))
  const prior = process.env[CONFIG_HOME_ENV]
  try {
    process.env[CONFIG_HOME_ENV] = join(root, 'config')
    expect(() => rollUpDays()).toThrow(
      `refusing to write daily totals without a machine identity; run ${PLATFORM_SLUG} machine migrate`,
    )
    await expect(ingestGit('2026-10-01')).rejects.toThrow(
      `refusing to write daily totals without a machine identity; run ${PLATFORM_SLUG} machine migrate`,
    )
  } finally {
    if (prior === undefined) delete process.env[CONFIG_HOME_ENV]
    else process.env[CONFIG_HOME_ENV] = prior
    rmSync(root, { recursive: true, force: true })
  }
})
