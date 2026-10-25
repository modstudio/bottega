import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  childEnvironmentForNamedSecrets,
  namedSecretUnresolvedRefusal,
  parseSecretRunArgs,
  SECRET_RUN_WORKING_FORM,
} from './secret-run.ts'

test('named keys are added over the base environment', () => {
  expect(
    childEnvironmentForNamedSecrets(
      ['TOKEN'],
      { TOKEN: 'fixture-token' },
      { PATH: '/bin', TOKEN: 'fixture-old' },
    ),
  ).toEqual({
    ok: true,
    env: { PATH: '/bin', TOKEN: 'fixture-token' },
  })
})

test('an unresolved name yields a refusal listing exactly the unresolved names', () => {
  expect(
    childEnvironmentForNamedSecrets(
      ['TOKEN', 'OTHER', 'TOKEN'],
      { TOKEN: undefined, OTHER: undefined, IGNORED: 'fixture-ignored' },
      { PATH: '/bin' },
    ),
  ).toEqual({ ok: false, unresolved: ['TOKEN', 'OTHER'] })
})

test('a key that is not named is not added even when the resolver would know it', () => {
  expect(
    childEnvironmentForNamedSecrets(
      ['TOKEN'],
      { TOKEN: 'fixture-token', OTHER: 'fixture-other' },
      { PATH: '/bin' },
    ),
  ).toEqual({
    ok: true,
    env: { PATH: '/bin', TOKEN: 'fixture-token' },
  })
})

test('missing --name is refused with the working form', () => {
  expect(() => parseSecretRunArgs(['--', 'echo', 'ok'])).toThrow(
    `missing --name\nworking form: ${SECRET_RUN_WORKING_FORM}`,
  )
})

test('missing -- is refused with the working form', () => {
  expect(() => parseSecretRunArgs(['--name', 'TOKEN', 'echo'])).toThrow(
    `missing --\nworking form: ${SECRET_RUN_WORKING_FORM}`,
  )
})

test('empty argv is refused with the working form', () => {
  expect(() => parseSecretRunArgs(['--name', 'TOKEN', '--'])).toThrow(
    `empty argv\nworking form: ${SECRET_RUN_WORKING_FORM}`,
  )
})

test('names and argv are taken from --name flags and the literal --', () => {
  expect(
    parseSecretRunArgs(['--name', 'TOKEN', '--name', 'OTHER', '--', 'echo', '--help']),
  ).toEqual({
    names: ['TOKEN', 'OTHER'],
    argv: ['echo', '--help'],
  })
})

test('a name that is sealed empty is refused as sealed empty', () => {
  expect(namedSecretUnresolvedRefusal(['TOKEN'], ['TOKEN'])).toBe(
    `named secret TOKEN is sealed empty\ncleared by: ${PLATFORM_SLUG} machine config secret set TOKEN, or add it to an env file the resolver reads`,
  )
})

test('names that are simply not set keep the not-set refusal', () => {
  expect(namedSecretUnresolvedRefusal(['TOKEN'], [])).toBe(
    `named secret TOKEN not set\ncleared by: ${PLATFORM_SLUG} machine config secret set TOKEN, or add it to an env file the resolver reads`,
  )
  expect(namedSecretUnresolvedRefusal(['TOKEN', 'OTHER'], [])).toContain(
    'named secrets TOKEN, OTHER not set',
  )
})

test('a mixed refusal names each group its own state', () => {
  const refusal = namedSecretUnresolvedRefusal(['EMPTY_KEY', 'MISSING_KEY'], ['EMPTY_KEY'])
  expect(refusal).toContain('named secrets EMPTY_KEY is sealed empty, MISSING_KEY not set')
  expect(refusal).toContain(`${PLATFORM_SLUG} machine config secret set EMPTY_KEY`)
  expect(refusal).toContain(`${PLATFORM_SLUG} machine config secret set MISSING_KEY`)
})
