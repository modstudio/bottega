import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { spawnsCommand } from './spawn-commands.ts'

test('recent spawn decisions are ordered by their recorded time, then their UUID', () => {
  const insert = db().query(
    'INSERT INTO spawn(record_id,at,decision,why,description) VALUES (?,?,?,?,?)',
  )
  const shown = () => {
    const lines: string[] = []
    spawnsCommand(1, { log: (value) => lines.push(value) })
    return lines.join('\n')
  }
  // The later decision is inserted first, so it also has the smaller UUID and
  // rowid: only the recorded time can put it on top.
  insert.run(newRecordId(), '2026-10-24T02:00:00.000Z', 'blocked', 'later', 'later decision')
  insert.run(newRecordId(), '2026-10-24T01:00:00.000Z', 'allowed', 'earlier', 'earlier decision')
  expect(shown()).toContain('later decision')
  expect(shown()).not.toContain('earlier decision')
  // Same second: the greater UUID decides.
  insert.run(
    '01990000-0000-7000-8000-0000000000a1',
    '2026-10-24T03:00:00.000Z',
    'allowed',
    'tie',
    'smaller id',
  )
  insert.run(
    '01990000-0000-7000-8000-0000000000a2',
    '2026-10-24T03:00:00.000Z',
    'allowed',
    'tie',
    'greater id',
  )
  expect(shown()).toContain('greater id')
  expect(shown()).not.toContain('smaller id')
})
