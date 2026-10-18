import { expect, test } from 'bun:test'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { rememberHostedRecord } from '../record/install-binding.ts'
import { BOUND_RECORD_WRITE_REFUSAL } from '../record/record-write-authority.ts'
import { setLens, showLens } from './lenses.ts'

test('a hosted lens failure leaves the local catalogue unchanged', async () => {
  const before = showLens('correctness')
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    upsertLens: async () => {
      throw new Error('hosted lens write failed')
    },
  })
  try {
    await expect(
      setLens({
        id: 'correctness',
        title: 'Changed remotely first',
        question: before!.question,
        excludes: before!.excludes,
        slots: JSON.stringify(before!.slots),
        enabled: true,
        requiresExecution: false,
        reason: 'prove hosted ordering',
      }),
    ).rejects.toThrow('hosted lens write failed')
    expect(showLens('correctness')).toEqual(before)
  } finally {
    delete process.env.ORCH_RECORD_API_URL
    installRecordApiClient(createMemoryRecordApiClient())
  }
})

test('lens writes stay local-authoritative without a record and refuse a bound missing endpoint', async () => {
  delete process.env.ORCH_RECORD_API_URL
  const created = await setLens({
    id: 'local-authoritative-lens',
    title: 'Local lens',
    question: 'Does local authority work?',
    excludes: 'Hosted behavior.',
    slots: '{"type":"object","properties":{},"additionalProperties":false}',
    enabled: true,
    requiresExecution: false,
    reason: 'prove local branch',
  })
  expect(created.id).toBe('local-authoritative-lens')
  rememberHostedRecord(db())
  try {
    await expect(
      setLens({
        id: 'local-authoritative-lens',
        title: 'Must not change',
        question: 'Does refusal work?',
        excludes: 'Nothing.',
        slots: '{"type":"object","properties":{},"additionalProperties":false}',
        enabled: true,
        requiresExecution: false,
        reason: 'prove refusal branch',
      }),
    ).rejects.toThrow(BOUND_RECORD_WRITE_REFUSAL)
    expect(showLens('local-authoritative-lens')!.title).toBe('Local lens')
  } finally {
    db().query('DELETE FROM record_install_binding').run()
  }
})
