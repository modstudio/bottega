import { expect, test } from 'bun:test'
import { RefusalError } from '../refusal-error.ts'
import { startupFailureDiagnostic } from './exec.ts'

test('a startup refusal reports its message without a stack', () => {
  const refusal = new RefusalError('run orch agent probe codex')
  expect(startupFailureDiagnostic(refusal)).toBe('run orch agent probe codex')
})

test('an unexpected startup error keeps its stack', () => {
  const error = new Error('unexpected startup failure')
  expect(startupFailureDiagnostic(error)).toBe(error.stack!)
})
