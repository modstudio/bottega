import { expect, test } from 'bun:test'
import { currentHostedWriterFindings, hostedWriterFindings } from './check-hosted-secret-writers.ts'

test('production hosted writes use the masked writer', async () => {
  expect(await currentHostedWriterFindings()).toEqual([])
})

test('bypassing a hosted table writer fails the guard', () => {
  const bypass = String.raw`await tx\`INSERT INTO hub_task (title) VALUES (\${input.title})\``
  expect(hostedWriterFindings('hub/src/probe.ts', bypass)).toEqual([
    { file: 'hub/src/probe.ts', table: 'hub_task' },
  ])
  expect(
    hostedWriterFindings(
      'hub/src/probe.ts',
      String.raw`const row = maskHostedTableWrite('hub_task', input)
await tx\`INSERT INTO hub_task (title) VALUES (\${row.title})\``,
    ),
  ).toEqual([])
})
