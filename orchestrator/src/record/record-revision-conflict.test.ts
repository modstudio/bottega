import { expect, test } from 'bun:test'
import { revisionConflictBody, revisionConflictBodySchema } from './record-revision-conflict.ts'

test('revision conflict wire body carries its typed current revision and remedy', () => {
  const body = revisionConflictBody('revision-current')

  expect(revisionConflictBodySchema.parse(body)).toEqual({
    error: 'hosted revision conflict; current revision is revision-current; re-read, then retry',
    code: 'revision-conflict',
    currentRevision: 'revision-current',
  })
})
