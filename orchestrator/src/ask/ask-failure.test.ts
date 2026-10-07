import { expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { askServerFailurePath, readAskServerFailure, writeAskServerFailure } from './ask-failure.ts'

const trackResidue = trackedTestResidue()

test('ask startup failure leaves exactly one sanitized line in run scratch', () => {
  const scratch = trackResidue(join(dir, 'ask-failure-scratch'))
  mkdirSync(scratch)
  writeAskServerFailure(new Error('database setup failed\nprivate stack'), scratch)
  expect(readAskServerFailure(scratch)).toBe('database setup failed private stack')
  expect(Bun.file(askServerFailurePath(scratch)).text()).resolves.toBe(
    'database setup failed private stack\n',
  )
})
