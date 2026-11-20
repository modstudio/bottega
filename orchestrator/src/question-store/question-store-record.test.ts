import { expect, test } from 'bun:test'
import { QUESTION_RULINGS_PAGE_SIZE } from '../record/record-question-contract.ts'
import { rulingSpaceReadRequest } from './question-store-record.ts'

const request = (changedAfter?: string) => ({
  read: 'rulings' as const,
  kind: 'workflow' as const,
  ...(changedAfter === undefined ? {} : { changedAfter }),
})

test('each hosted ruling space request carries exactly one bound', () => {
  expect(rulingSpaceReadRequest(request('0'), undefined)).toEqual({
    read: 'rulings',
    kind: 'workflow',
    limit: QUESTION_RULINGS_PAGE_SIZE,
  })
  expect(rulingSpaceReadRequest(request('encoded-spaces'), undefined)).toEqual({
    read: 'rulings',
    kind: 'workflow',
    limit: QUESTION_RULINGS_PAGE_SIZE,
  })
  expect(rulingSpaceReadRequest(request('encoded-spaces'), 'page:12:head')).toEqual({
    read: 'rulings',
    kind: 'workflow',
    changedAfter: 'page:12:head',
  })
  expect(rulingSpaceReadRequest(request('encoded-spaces'), 'change-head')).toEqual({
    read: 'rulings',
    kind: 'workflow',
    changedAfter: 'change-head',
  })
})
