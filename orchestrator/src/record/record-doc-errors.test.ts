import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  DocRevisionConflictError,
  revisionConflictBody,
} from '../doc/doc-revision-conflict.ts'
import { assertRevisionWrite } from './record-doc-errors.ts'

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

test('a missing hosted revision carries its reason for refused client classification', () => {
  const error = capture({ ...address, isCreate: false, current: null })
  expect(error).toBeInstanceOf(DocRevisionConflictError)
  expect(revisionConflictBody(error as DocRevisionConflictError)).toMatchObject({
    code: 'revision-conflict',
    reason: 'missing-hosted-revision',
    currentRevision: null,
  })
})

test('an already-existing row returns its specific remedy as a typed conflict', () => {
  const error = capture({ ...address, op: 'create', isCreate: false, current: 'revision-2' })
  expect(error).toBeInstanceOf(DocRevisionConflictError)
  expect(error).toMatchObject({ status: 409, currentRevision: 'revision-2' })
  expect(revisionConflictBody(error as DocRevisionConflictError)).toEqual({
    error:
      'refusing create for canon/_/revision-test: the row already exists at revision revision-2\n' +
      `cleared by: read the doc, then write it with ${PLATFORM_SLUG} doc set revision-test --scope canon --expect revision-2`,
    code: 'revision-conflict',
    reason: 'already-exists',
    condition: 'refusing create for canon/_/revision-test: the row already exists at revision revision-2',
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
  expect(error).toBeInstanceOf(DocRevisionConflictError)
  expect(error).toMatchObject({ status: 409, currentRevision: 'revision-2' })
  expect(revisionConflictBody(error as DocRevisionConflictError)).toMatchObject({
    code: 'revision-conflict',
    reason: 'stale-revision',
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
  expect(revisionConflictBody(error as DocRevisionConflictError)).toMatchObject({
    code: 'revision-conflict',
    currentRevision: null,
  })
  expect(error.message).not.toContain('retry')
})
