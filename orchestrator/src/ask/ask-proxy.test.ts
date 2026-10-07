import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import { trackedTestResidue } from '../../test/residue.ts'
import { readAskServerFailure } from './ask-failure.ts'
import { recordAskProxyFailure } from './ask-proxy.ts'

const trackResidue = trackedTestResidue()

test('proxy failure leaves the ask-server failure line without launching the proxy', () => {
  const scratch = trackResidue(join(dir, 'ask-proxy-failure-scratch'))
  const error = new Error('ORCH_ASK_URL is required')
  expect(recordAskProxyFailure(error, scratch)).toBe(error)
  expect(readAskServerFailure(scratch)).toBe('ORCH_ASK_URL is required')
})
