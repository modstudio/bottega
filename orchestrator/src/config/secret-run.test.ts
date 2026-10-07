import { expect, test } from 'bun:test'
import {
  childEnvironmentForNamedSecrets,
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
