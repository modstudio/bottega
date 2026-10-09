import { expect, test } from 'bun:test'
import {
  assertRecordConnectionResolutionAllowed,
  isForwardedChildEnvName,
  RECORD_CONNECTION_ENV_NAMES,
  recordConnectionResolverRefusal,
  withheldClassNamesForwardedFrom,
} from './record-connection-env.ts'

test('childEnv forwards ORCH_RECORD_URL from the parent into the vendor process', () => {
  expect(RECORD_CONNECTION_ENV_NAMES.has('ORCH_RECORD_URL')).toBe(true)
  expect(RECORD_CONNECTION_ENV_NAMES.has('ORCH_RECORD_MIGRATE_URL')).toBe(true)
  expect(isForwardedChildEnvName('ORCH_RECORD_URL')).toBe(false)
  expect(isForwardedChildEnvName('ORCH_RECORD_MIGRATE_URL')).toBe(false)
})

test('every other ORCH_ name still reaches the vendor process', () => {
  expect(isForwardedChildEnvName('ORCH_DB')).toBe(true)
  expect(isForwardedChildEnvName('ORCH_RUN_ID')).toBe(true)
  expect(isForwardedChildEnvName('PATH')).toBe(true)
  expect(isForwardedChildEnvName('SECRET_TOKEN')).toBe(false)
})

test('a parent environment holding both record URLs forwards neither', () => {
  expect(
    withheldClassNamesForwardedFrom([
      'ORCH_RECORD_URL',
      'ORCH_RECORD_MIGRATE_URL',
      'ORCH_DB',
      'PATH',
    ]),
  ).toEqual([])
})

test('orch config secret run resolves a record database connection for a worker', () => {
  expect(recordConnectionResolverRefusal('ORCH_RECORD_URL', true)).toBe(
    'ORCH_RECORD_URL: record database connections are withheld from workers; the architect session runs work that needs one',
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
