import { expect, test } from 'bun:test'
import {
  assertRecordConnectionResolutionAllowed,
  isForwardedChildEnvName,
  RECORD_CONNECTION_ENV_NAMES,
  RECORD_CONNECTION_WORKER_REFUSAL,
  recordConnectionResolverRefusal,
  withheldClassNamesForwardedFrom,
} from './record-connection-env.ts'

test('childEnv does not forward record connection names', () => {
  expect(RECORD_CONNECTION_ENV_NAMES.has('ORCH_RECORD_URL')).toBe(true)
  expect(RECORD_CONNECTION_ENV_NAMES.has('ORCH_RECORD_MIGRATE_URL')).toBe(true)
  expect(isForwardedChildEnvName('ORCH_RECORD_URL')).toBe(false)
  expect(isForwardedChildEnvName('ORCH_RECORD_MIGRATE_URL')).toBe(false)
})

test('ORCH_ names other than record connections are forwarded, and unrelated names are not', () => {
  expect(isForwardedChildEnvName('ORCH_DB')).toBe(true)
  expect(isForwardedChildEnvName('ORCH_RUN_ID')).toBe(true)
  expect(isForwardedChildEnvName('PATH')).toBe(true)
  expect(isForwardedChildEnvName('SECRET_TOKEN')).toBe(false)
})

test('a parent environment holding both record connection names forwards neither as withheld-class', () => {
  expect(
    withheldClassNamesForwardedFrom([
      'ORCH_RECORD_URL',
      'ORCH_RECORD_MIGRATE_URL',
      'ORCH_DB',
      'PATH',
    ]),
  ).toEqual([])
})

test('a worker process is refused when resolving a record connection name', () => {
  expect(recordConnectionResolverRefusal('ORCH_RECORD_URL', true)).toBe(
    `ORCH_RECORD_URL: ${RECORD_CONNECTION_WORKER_REFUSAL}`,
  )
  expect(recordConnectionResolverRefusal('ORCH_RECORD_MIGRATE_URL', true)).toContain(
    'ORCH_RECORD_MIGRATE_URL',
  )
  expect(() =>
    assertRecordConnectionResolutionAllowed(['ORCH_RECORD_URL'], { ORCH_DEPTH: '1' }),
  ).toThrow('ORCH_RECORD_URL')
})

test('other named secrets still resolve in a worker, and the architect session still resolves record URLs', () => {
  expect(recordConnectionResolverRefusal('OPENAI_API_KEY', true)).toBeNull()
  expect(recordConnectionResolverRefusal('ORCH_RECORD_URL', false)).toBeNull()
  expect(() =>
    assertRecordConnectionResolutionAllowed(['OPENAI_API_KEY', 'ORCH_RECORD_URL'], {}),
  ).not.toThrow()
})
