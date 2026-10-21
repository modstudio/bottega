import { expect, test } from 'bun:test'
import { constants } from 'node:os'
import { classifyClonefileErrno } from './clone-directory-outcome.ts'

test('clonefile errno mapping falls back only for unsupported operations', () => {
  expect(classifyClonefileErrno(constants.errno.ENOTSUP)).toEqual({
    status: 'unsupported',
    errno: constants.errno.ENOTSUP,
    errnoName: 'ENOTSUP',
  })
  expect(classifyClonefileErrno(constants.errno.EXDEV)).toEqual({
    status: 'unsupported',
    errno: constants.errno.EXDEV,
    errnoName: 'EXDEV',
  })
  expect(classifyClonefileErrno(constants.errno.EACCES)).toEqual({
    status: 'failed',
    errno: constants.errno.EACCES,
    errnoName: 'EACCES',
  })
})
