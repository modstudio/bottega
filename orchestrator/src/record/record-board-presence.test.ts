import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { BOARD_PRESENCE_RETENTION_MS } from './record-board-presence.ts'

const migration = readFileSync(
  join(
    import.meta.dir,
    '../../../shared/record/migrations/20261108021243_dev_2154_board_successor_functions/migration.sql',
  ),
  'utf8',
)

test('hosted successor and presence SQL intervals match their TypeScript constants', () => {
  const milliseconds = [...migration.matchAll(/interval '(\d+) (hour|days)'/g)].map(
    ([, amount, unit]) => Number(amount) * (unit === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000),
  )
  expect(milliseconds).toEqual([SESSION_LIVE_MS, BOARD_PRESENCE_RETENTION_MS])
})
