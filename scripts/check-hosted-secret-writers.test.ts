import { expect, test } from 'bun:test'
import { hostedWriterGuard } from './check-hosted-secret-writers.ts'

test('production hosted writes use the masked writer', async () => {
  expect(await hostedWriterGuard.currentFindings()).toEqual([])
})

test('bypassing a hosted table writer fails the guard', () => {
  const bypass =
    'async function probe() { await tx`INSERT INTO hub_task (title) VALUES (${input.title})` }'
  expect(hostedWriterGuard.findings('hub/src/probe.ts', bypass)).toEqual([
    { file: 'hub/src/probe.ts', table: 'hub_task', line: 1, reason: 'no preceding masked binding' },
  ])
  expect(
    hostedWriterGuard.findings(
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
  expect(hostedWriterGuard.findings('hub/src/hosted-tasks.ts', source)).toEqual([
    {
      file: 'hub/src/hosted-tasks.ts',
      table: 'hub_task',
      line: 6,
      reason: 'no preceding masked binding',
    },
  ])
})

test('a structured-only update needs no masked binding', () => {
  const source = `async function counter() {
await tx\`UPDATE hub_task SET next_document_number=\${next} WHERE id=\${id}\`
}`
  expect(hostedWriterGuard.findings('hub/src/hosted-tasks.ts', source)).toEqual([])
  expect(hostedWriterGuard.inspect('hub/src/hosted-tasks.ts', source).verdicts).toEqual({
    masked: 0,
    structured: 1,
  })
})

test('an unmasked Drizzle builder insert into a hosted table fails', () => {
  const source = `import { question as questionRecord } from '../shared/record/schema-question.ts'
async function probe() {
  await drizzle({ client: tx }).insert(questionRecord).values(input)
}`
  expect(hostedWriterGuard.findings('scripts/probe.ts', source)).toEqual([
    {
      file: 'scripts/probe.ts',
      table: 'question',
      line: 3,
      reason: 'builder values have no preceding masked binding',
    },
  ])
})

test('a Drizzle builder insert into an outbox-synced table passes and is reported', () => {
  const source = `import { run as runRecord } from '../shared/record/schema-run.ts'
async function probe() {
  await drizzle({ client: tx }).insert(runRecord).values(input)
}`
  const inspection = hostedWriterGuard.inspect('scripts/probe.ts', source)
  expect(inspection.findings).toEqual([])
  expect(inspection.builderSites).toEqual([
    {
      file: 'scripts/probe.ts',
      line: 3,
      table: 'run',
      operation: 'insert',
      verdict: 'outside-inventory',
    },
  ])
})
