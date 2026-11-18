import { expect, test } from 'bun:test'
import { type BoardWriteDropped, hostedBoardWriteResult } from './board-write-result.ts'

// @ts-expect-error Board write results cannot assign `dropped` from a literal.
const literalDropped: BoardWriteDropped = false
void literalDropped

const mintedId = '01990000-0000-7000-8000-000000000001'
const duplicateId = '01990000-0000-7000-8000-000000000002'

test('hosted board write results distinguish retries and duplicate response versions', () => {
  const explicitRetry = hostedBoardWriteResult(mintedId, { id: mintedId, duplicateOf: null })
  expect(Boolean(explicitRetry.dropped)).toBeFalse()
  expect(explicitRetry.duplicateOf).toBeNull()
  const legacyRetry = hostedBoardWriteResult(mintedId, { id: mintedId })
  expect(Boolean(legacyRetry.dropped)).toBeFalse()
  expect(legacyRetry.duplicateOf).toBeNull()
  const explicitDuplicate = hostedBoardWriteResult(mintedId, {
    id: duplicateId,
    duplicateOf: duplicateId,
  })
  expect(Boolean(explicitDuplicate.dropped)).toBeTrue()
  expect(explicitDuplicate.duplicateOf).toBe(duplicateId)
  const legacyDuplicate = hostedBoardWriteResult(mintedId, { id: duplicateId })
  expect(Boolean(legacyDuplicate.dropped)).toBeTrue()
  expect(legacyDuplicate.duplicateOf).toBe(duplicateId)
})
