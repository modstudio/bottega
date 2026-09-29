import { expect, test } from 'bun:test'
import { outboxPayloadContractFailures } from './check-outbox-payload-contracts.ts'

test('accepts the base columns plus laterAdded columns', () => {
  expect(
    outboxPayloadContractFailures(
      { run: ['id', 'status'] },
      { run: { columns: ['id', 'status', 'detail'], laterAdded: { detail: null } } },
    ),
  ).toEqual([])
})

test('refuses a column added to an existing kind without a fill', () => {
  expect(
    outboxPayloadContractFailures(
      { run: ['id'] },
      { run: { columns: ['id', 'status'], laterAdded: {} } },
    ),
  ).toEqual([
    'run.status: current column is neither a base column nor laterAdded; add a laterAdded fill',
  ])
})

test('refuses removing a base column', () => {
  expect(
    outboxPayloadContractFailures(
      { run: ['id', 'status'] },
      { run: { columns: ['id'], laterAdded: {} } },
    ),
  ).toEqual([
    'run.status: base column is no longer current; perform a deliberate migration, never a baseline edit',
  ])
})

test('refuses a laterAdded key that is not current', () => {
  expect(
    outboxPayloadContractFailures(
      { run: ['id'] },
      { run: { columns: ['id'], laterAdded: { status: null } } },
    ),
  ).toEqual(['run.status: laterAdded key is not a current column'])
})

test('refuses a new kind', () => {
  expect(outboxPayloadContractFailures({}, { score: { columns: ['id'], laterAdded: {} } })).toEqual(
    ['score: new outbox kind; add its base column set to the baseline'],
  )
})

test('refuses a stale baseline kind', () => {
  expect(outboxPayloadContractFailures({ score: ['id'] }, {})).toEqual([
    'score: stale baseline kind is no longer registered',
  ])
})
