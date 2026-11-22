import { expect, test } from 'bun:test'
import { hostedWriterFindings } from './check-hosted-secret-writers.ts'

test('bypassing a hosted table writer fails the guard', () => {
  const bypass = "await tx`INSERT INTO hub_task (title) VALUES (${input.title})`"
  expect(hostedWriterFindings('hub/src/probe.ts', bypass)).toEqual([
    { file: 'hub/src/probe.ts', table: 'hub_task' },
  ])
  expect(
    hostedWriterFindings(
      'hub/src/probe.ts',
      "const row = maskHostedTableWrite('hub_task', input)\nawait tx`INSERT INTO hub_task (title) VALUES (${row.title})`",
    ),
  ).toEqual([])
})
