import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assertRevisionWrite, RecordDocError } from './record-doc-errors.ts'
import { RecordRevisionConflictError, revisionConflictBody } from './record-revision-conflict.ts'

const address = { scope: 'canon', subject: null, slug: 'revision-test' }

function capture(input: Parameters<typeof assertRevisionWrite>[0]): Error {
  try {
    assertRevisionWrite(input)
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected revision write to refuse')
}

test('a missing hosted revision remains an untyped 409 refusal', () => {
  const error = capture({ ...address, isCreate: false, current: null })
  expect(error).toBeInstanceOf(RecordDocError)
  expect(error).toMatchObject({ status: 409 })
  expect(error).not.toHaveProperty('code')
  expect(error).not.toHaveProperty('currentRevision')
})

test('an already-existing row returns its specific remedy as a typed conflict', () => {
  const error = capture({ ...address, op: 'create', isCreate: false, current: 'revision-2' })
  expect(error).toBeInstanceOf(RecordRevisionConflictError)
  expect(error).toMatchObject({ status: 409, currentRevision: 'revision-2' })
  expect(revisionConflictBody(error.message, 'revision-2')).toEqual({
    error:
      'refusing create for canon/_/revision-test: the row already exists at revision revision-2\n' +
      `cleared by: read the doc, then write it with ${PLATFORM_SLUG} doc set revision-test --scope canon --expect revision-2`,
    code: 'revision-conflict',
    currentRevision: 'revision-2',
  })
})

test('a stale write returns the current revision and decision remedy', () => {
  const error = capture({
    ...address,
    expectedRevision: 'revision-1',
    isCreate: false,
    current: 'revision-2',
  })
  expect(error).toBeInstanceOf(RecordRevisionConflictError)
  expect(error).toMatchObject({ status: 409, currentRevision: 'revision-2' })
  expect(revisionConflictBody(error.message, 'revision-2')).toMatchObject({
    code: 'revision-conflict',
    currentRevision: 'revision-2',
  })
  expect(error.message).toContain(
    `${PLATFORM_SLUG} doc set revision-test --scope canon --expect revision-2`,
  )
})

test('a conflict without a current revision does not tell the caller to retry', () => {
  const error = capture({
    ...address,
    expectedRevision: 'revision-1',
    isCreate: true,
    current: null,
  })
  expect(revisionConflictBody(error.message, null)).toMatchObject({
    code: 'revision-conflict',
    currentRevision: null,
  })
  expect(error.message).not.toContain('retry')
})
