import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { recordHostedChangeEvidence } from './hosted-change-evidence.ts'
import { runHostedChangeEvidenceCommand } from './hosted-change-evidence-cli.ts'

beforeEach(resetFixtureStore)

test('changes filters and renders event and summary text and JSON', () => {
  writeTransaction((conn) => {
    recordHostedChangeEvidence(conn, {
      observedAt: '2026-10-09T12:00:00.000Z',
      family: 'task',
      spaceId: 'space-one',
      table: 'hub_task',
      rowId: 'task-one',
      kind: 'changed-upsert',
      differingColumns: ['body', 'updated_at'],
    })
    recordHostedChangeEvidence(conn, {
      observedAt: '2026-10-09T12:01:00.000Z',
      family: 'note',
      spaceId: 'space-two',
      table: 'hub_note',
      rowId: 'note-one',
      kind: 'changed-upsert',
      differingColumns: ['text'],
    })
    recordHostedChangeEvidence(conn, {
      observedAt: '2026-10-09T12:02:00.000Z',
      family: 'task',
      spaceId: 'space-one',
      table: 'hub_task',
      rowId: 'task-two',
      kind: 'applied-delete',
      differingColumns: [],
    })
  })

  const taskFilter = ['--family', 'task', '--space', 'space-one', '--kind', 'changed-upsert']
  expect(runHostedChangeEvidenceCommand(taskFilter)).toEqual([
    '2026-10-09T12:00:00.000Z  task  space-one  hub_task  task-one  changed-upsert  columns body,updated_at',
  ])
  expect(runHostedChangeEvidenceCommand([...taskFilter, '--json'])).toEqual([
    JSON.stringify([
      {
        observed_at: '2026-10-09T12:00:00.000Z',
        family: 'task',
        space_id: 'space-one',
        table: 'hub_task',
        row_id: 'task-one',
        kind: 'changed-upsert',
        differing_columns: ['body', 'updated_at'],
      },
    ]),
  ])
  expect(runHostedChangeEvidenceCommand([...taskFilter, '--summary'])).toEqual([
    'hub_task  body,updated_at  1',
  ])
  expect(runHostedChangeEvidenceCommand([...taskFilter, '--summary', '--json'])).toEqual([
    JSON.stringify([{ table: 'hub_task', differing_columns: ['body', 'updated_at'], count: 1 }]),
  ])

  const output = runHostedChangeEvidenceCommand([...taskFilter, '--json']).join('\n')
  expect(output).not.toContain('hub_note')
  expect(output).not.toContain('note-one')
  expect(output).not.toContain('task-two')
  expect(output).not.toContain('private task body')
  expect(output).not.toContain('private note text')
})
