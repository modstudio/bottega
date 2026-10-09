import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import {
  KEEP_HOSTED_CHANGE_EVIDENCE_DAYS,
  listHostedChangeEvidence,
  pruneHostedChangeEvidence,
  recordHostedChangeEvidence,
  summarizeHostedChangeEvidence,
} from './hosted-change-evidence.ts'

beforeEach(resetFixtureStore)

const event = (overrides: Partial<Parameters<typeof recordHostedChangeEvidence>[1]> = {}) => ({
  family: 'task' as const,
  spaceId: 'space-one',
  table: 'hub_task',
  rowId: 'task-1',
  kind: 'changed-upsert' as const,
  differingColumns: ['status', 'updated_at'],
  ...overrides,
})

test('hosted change evidence retention removes only rows older than its named window', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z')
  writeTransaction((conn) => {
    recordHostedChangeEvidence(
      conn,
      event({
        rowId: 'old',
        observedAt: new Date(
          now - (KEEP_HOSTED_CHANGE_EVIDENCE_DAYS + 1) * 86_400_000,
        ).toISOString(),
      }),
    )
    recordHostedChangeEvidence(
      conn,
      event({ rowId: 'current', observedAt: new Date(now).toISOString() }),
    )
  })

  expect(pruneHostedChangeEvidence(now)).toBe(1)
  expect(listHostedChangeEvidence().map((row) => row.rowId)).toEqual(['current'])
})

test('hosted change evidence summary groups by table and differing column set', () => {
  writeTransaction((conn) => {
    recordHostedChangeEvidence(conn, event({ rowId: 'one' }))
    recordHostedChangeEvidence(conn, event({ rowId: 'two' }))
    recordHostedChangeEvidence(conn, event({ rowId: 'three', differingColumns: ['title'] }))
    recordHostedChangeEvidence(
      conn,
      event({
        family: 'note',
        table: 'hub_note',
        rowId: 'note-1',
        differingColumns: ['text'],
      }),
    )
  })

  expect(summarizeHostedChangeEvidence()).toEqual([
    { table: 'hub_task', differingColumns: ['status', 'updated_at'], count: 2 },
    { table: 'hub_note', differingColumns: ['text'], count: 1 },
    { table: 'hub_task', differingColumns: ['title'], count: 1 },
  ])
  expect(summarizeHostedChangeEvidence({ family: 'note' })).toEqual([
    { table: 'hub_note', differingColumns: ['text'], count: 1 },
  ])
})
