import { expect, test } from 'bun:test'
import { OrchQuestionSchema } from '../../../shared/orch-contract.ts'
import { listingQuestion } from './run-listing.ts'

test('hosted question timestamps satisfy the run-list contract', () => {
  const question = {
    number: 17,
    record_id: '00000000-0000-4000-8000-000000000017',
    space_id: '00000000-0000-4000-8000-000000000099',
    run_record_id: '00000000-0000-4000-8000-000000000018',
    run_number: 18,
    asked_at: '2026-11-17T04:05:04.603Z',
    answered_at: null,
    overturned_at: '2026-11-17T05:06:07.008Z',
    closed_at: null,
  }

  expect(OrchQuestionSchema.parse(listingQuestion(question))).toMatchObject({
    asked_at: '2026-11-17T04:05:04.603Z',
    answered_at: null,
    overturned_at: '2026-11-17T05:06:07.008Z',
    space_id: '00000000-0000-4000-8000-000000000099',
  })
})
