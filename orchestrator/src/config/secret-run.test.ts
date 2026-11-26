import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  childEnvironmentForNamedSecrets,
  matchingTypedCredentialPath,
  namedSecretUnresolvedRefusal,
  parseSecretRunArgs,
  SECRET_RUN_WORKING_FORM,
  typedCredentialPathsOrUnchecked,
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

test('conventional API key names match only listed typed credential paths', () => {
  const available = ['openrouter/api-key', 'vercel/api-key']
  expect(matchingTypedCredentialPath('OPENROUTER_API_KEY', available)).toBe('openrouter/api-key')
  expect(matchingTypedCredentialPath('VERCEL_API_KEY', available)).toBe('vercel/api-key')
  expect(matchingTypedCredentialPath('OPENROUTER_TOKEN', available)).toBeNull()
  expect(matchingTypedCredentialPath('BASETEN_API_KEY', available)).toBeNull()
})

test('typed credential path lookup is optional and failures remain unchecked', async () => {
  await expect(typedCredentialPathsOrUnchecked()).resolves.toBeUndefined()
  await expect(
    typedCredentialPathsOrUnchecked(async () => {
      throw new Error('fixture unavailable')
    }),
  ).resolves.toBeUndefined()
  await expect(
    typedCredentialPathsOrUnchecked(async () => ['openrouter/api-key']),
  ).resolves.toEqual(['openrouter/api-key'])
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
    `named secret TOKEN is sealed empty\ncleared by: ${PLATFORM_SLUG} machine config secret set TOKEN, ${PLATFORM_SLUG} credential list, or add it to an env file the resolver reads`,
  )
})

test('names that are simply not set keep the not-set refusal', () => {
  expect(namedSecretUnresolvedRefusal(['TOKEN'], [])).toBe(
    `named secret TOKEN not set\ncleared by: ${PLATFORM_SLUG} machine config secret set TOKEN, ${PLATFORM_SLUG} credential list, or add it to an env file the resolver reads`,
  )
  expect(namedSecretUnresolvedRefusal(['TOKEN', 'OTHER'], [])).toContain(
    'named secrets TOKEN, OTHER not set',
  )
})

test('a matching typed credential replaces the duplicate config-secret remedy', () => {
  const refusal = namedSecretUnresolvedRefusal(['OPENROUTER_API_KEY'], [], ['openrouter/api-key'])
  expect(refusal).toContain(`${PLATFORM_SLUG} credential resolve openrouter/api-key -- <argv>`)
  expect(refusal).not.toContain('machine config secret set OPENROUTER_API_KEY')
  expect(refusal).not.toContain('credential list')
})

test('checked credentials without a match still point to credential list', () => {
  expect(namedSecretUnresolvedRefusal(['OTHER_SECRET'], [], ['openrouter/api-key'])).toContain(
    `${PLATFORM_SLUG} credential list`,
  )
})

test('a mixed refusal names each group its own state', () => {
  const refusal = namedSecretUnresolvedRefusal(['EMPTY_KEY', 'MISSING_KEY'], ['EMPTY_KEY'])
  expect(refusal).toContain('named secrets EMPTY_KEY is sealed empty, MISSING_KEY not set')
  expect(refusal).toContain(`${PLATFORM_SLUG} machine config secret set EMPTY_KEY`)
  expect(refusal).toContain(`${PLATFORM_SLUG} machine config secret set MISSING_KEY`)
})
