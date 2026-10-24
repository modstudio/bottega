import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { spawnsCommand } from './spawn-commands.ts'

test('recent spawn decisions are ordered by their recorded time', () => {
  db()
    .query(
      `INSERT INTO spawn(record_id,at,decision,why,description)
       VALUES (?,?,?,?,?),(?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      '2026-10-24T01:00:00.000Z',
      'allowed',
      'earlier',
      'earlier decision',
      newRecordId(),
      '2026-10-24T02:00:00.000Z',
      'blocked',
      'later',
      'later decision',
    )
  const lines: string[] = []
  spawnsCommand(1, { log: (value) => lines.push(value) })
  expect(lines.join('\n')).toContain('later decision')
  expect(lines.join('\n')).not.toContain('earlier decision')
})
