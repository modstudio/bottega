import { expect, test } from 'bun:test'
import {
  currentHostedWriterFindings,
  hostedWriterFindings,
  inspectHostedWriters,
} from './check-hosted-secret-writers.ts'

test('production hosted writes use the masked writer', async () => {
  expect(await currentHostedWriterFindings()).toEqual([])
})

test('bypassing a hosted table writer fails the guard', () => {
  const bypass = 'async function probe() { await tx`INSERT INTO hub_task (title) VALUES (${input.title})` }'
  expect(hostedWriterFindings('hub/src/probe.ts', bypass)).toEqual([
    { file: 'hub/src/probe.ts', table: 'hub_task', line: 1, reason: 'no preceding masked binding' },
  ])
  expect(
    hostedWriterFindings(
      'hub/src/probe.ts',
      `async function probe() {
const row = maskHostedTableWrite('hub_task', input)
await tx\`INSERT INTO hub_task (title) VALUES (\${row.title})\`
}`,
    ),
  ).toEqual([])
})

test('an unmasked free-text update fails even when its file has another mask call', () => {
  const source = `async function safe() {
const row = maskHostedTableWrite('hub_task', input)
await tx\`UPDATE hub_task SET title=\${row.title} WHERE id=\${row.id}\`
}
async function bypass() {
await tx\`UPDATE hub_task SET title=\${input.title} WHERE id=\${input.id}\`
}`
  expect(hostedWriterFindings('hub/src/hosted-tasks.ts', source)).toEqual([
    { file: 'hub/src/hosted-tasks.ts', table: 'hub_task', line: 6, reason: 'no preceding masked binding' },
  ])
})

test('a structured-only update needs no masked binding', () => {
  const source = `async function counter() {
await tx\`UPDATE hub_task SET next_document_number=\${next} WHERE id=\${id}\`
}`
  expect(hostedWriterFindings('hub/src/hosted-tasks.ts', source)).toEqual([])
  expect(inspectHostedWriters('hub/src/hosted-tasks.ts', source).verdicts).toEqual({
    masked: 0,
    structured: 1,
  })
})
