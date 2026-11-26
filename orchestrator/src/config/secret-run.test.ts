import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { writeHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import {
  forgetRecordSessionToken,
  writeRecordSessionToken,
} from '../../../shared/record-session.ts'
import { generateMachineKeyPair } from '../../../shared/secret-envelope.ts'
import { STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import {
  childEnvironmentForNamedSecrets,
  matchingTypedCredentialPath,
  namedSecretUnresolvedRefusal,
  parseSecretRunArgs,
  runNamedSecrets,
  SECRET_RUN_WORKING_FORM,
  type TypedCredentialPathLookup,
  typedCredentialPathsOrUnchecked,
} from './secret-run.ts'

async function unresolvedNamedSecretRefusal(lookup: TypedCredentialPathLookup): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'secret-run-refusal-'))
  const previousFetch = globalThis.fetch
  const previous = {
    configHome: process.env[CONFIG_HOME_ENV],
    harnessEnv: process.env[HARNESS_ENV_FILE_ENV],
    keyStore: process.env.BOTTEGA_KEYSTORE,
    recordApi: process.env.BOTTEGA_RECORD_API_URL,
    stateHome: process.env[STATE_HOME_ENV],
    secret: process.env.OPENROUTER_API_KEY,
  }
  const spaceId = '01990000-0000-7000-8000-000000000041'
  const userId = '01990000-0000-7000-8000-000000000042'
  process.env[CONFIG_HOME_ENV] = root
  process.env[HARNESS_ENV_FILE_ENV] = ''
  process.env.BOTTEGA_KEYSTORE = 'file'
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  process.env[STATE_HOME_ENV] = root
  delete process.env.OPENROUTER_API_KEY
  writeRecordSessionToken(`fixture-${crypto.randomUUID()}`)
  writeMachineKey(await generateMachineKeyPair())
  writeHostedConfigIdentity({ spaceId, userId })
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/v1/whoami')
      return Response.json({ user: { id: userId }, activeSpaceId: spaceId })
    if (url.pathname === '/v1/config/trust-log') return Response.json({ entries: [] })
    if (url.pathname === '/v1/config/secrets/OPENROUTER_API_KEY')
      return Response.json({ error: 'fixture absent' }, { status: 404 })
    return Response.json({ error: `unexpected fixture route ${url.pathname}` }, { status: 500 })
  }) as typeof fetch
  try {
    await runNamedSecrets({ names: ['OPENROUTER_API_KEY'], argv: ['echo', 'ok'] }, lookup)
    throw new Error('expected named secret refusal')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    globalThis.fetch = previousFetch
    forgetRecordSessionToken()
    for (const [key, value] of [
      [CONFIG_HOME_ENV, previous.configHome],
      [HARNESS_ENV_FILE_ENV, previous.harnessEnv],
      ['BOTTEGA_KEYSTORE', previous.keyStore],
      ['BOTTEGA_RECORD_API_URL', previous.recordApi],
      [STATE_HOME_ENV, previous.stateHome],
      ['OPENROUTER_API_KEY', previous.secret],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}

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
  const available = [
    { path: 'openrouter/api-key', mode: 'default' as const },
    { path: 'vercel/api-key', mode: 'default' as const },
  ]
  expect(matchingTypedCredentialPath('OPENROUTER_API_KEY', available)).toEqual({
    path: 'openrouter/api-key',
    mode: 'default',
  })
  expect(matchingTypedCredentialPath('VERCEL_API_KEY', available)).toEqual({
    path: 'vercel/api-key',
    mode: 'default',
  })
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
    typedCredentialPathsOrUnchecked(async () => [{ path: 'openrouter/api-key', mode: 'default' }]),
  ).resolves.toEqual([{ path: 'openrouter/api-key', mode: 'default' }])
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
  const refusal = namedSecretUnresolvedRefusal(
    ['OPENROUTER_API_KEY'],
    [],
    [{ path: 'openrouter/api-key', mode: 'default' }],
  )
  expect(refusal).toContain(
    `${PLATFORM_SLUG} credential resolve openrouter/api-key --project <name> --reveal-to-env OPENROUTER_API_KEY -- <argv>`,
  )
  expect(refusal).not.toContain('machine config secret set OPENROUTER_API_KEY')
  expect(refusal).not.toContain('credential list')
})

test('checked credentials without a match still point to credential list', () => {
  expect(
    namedSecretUnresolvedRefusal(
      ['OTHER_SECRET'],
      [],
      [{ path: 'openrouter/api-key', mode: 'default' }],
    ),
  ).toContain(`${PLATFORM_SLUG} credential list`)
})

test('runNamedSecrets uses an injected typed credential remedy for an unresolved hosted name', async () => {
  const refusal = await unresolvedNamedSecretRefusal(async () => [
    { path: 'openrouter/api-key', mode: 'default' },
  ])
  expect(refusal).toContain(
    `${PLATFORM_SLUG} credential resolve openrouter/api-key --project <name> --reveal-to-env OPENROUTER_API_KEY`,
  )
  expect(refusal).not.toContain('machine config secret set')
})

test('runNamedSecrets names credential list when its typed credential lookup rejects', async () => {
  const refusal = await unresolvedNamedSecretRefusal(async () => {
    throw new Error('fixture credential listing unavailable')
  })
  expect(refusal).toContain(`${PLATFORM_SLUG} credential list`)
})

test('a sole non-default credential mode is carried into the resolve remedy', () => {
  const refusal = namedSecretUnresolvedRefusal(
    ['OPENROUTER_API_KEY'],
    [],
    [{ path: 'openrouter/api-key', mode: 'live' }],
  )
  expect(refusal).toContain('credential resolve openrouter/api-key --mode live --project <name>')
})

test('default mode wins while several non-default modes are treated as no match', () => {
  const rows = [
    { path: 'openrouter/api-key', mode: 'live' as const },
    { path: 'openrouter/api-key', mode: 'test' as const },
  ]
  expect(namedSecretUnresolvedRefusal(['OPENROUTER_API_KEY'], [], rows)).toContain(
    `${PLATFORM_SLUG} credential list`,
  )
  expect(
    namedSecretUnresolvedRefusal(
      ['OPENROUTER_API_KEY'],
      [],
      [...rows, { path: 'openrouter/api-key', mode: 'default' }],
    ),
  ).toContain('credential resolve openrouter/api-key --project <name>')
})

test('a mixed refusal names each group its own state', () => {
  const refusal = namedSecretUnresolvedRefusal(['EMPTY_KEY', 'MISSING_KEY'], ['EMPTY_KEY'])
  expect(refusal).toContain('named secrets EMPTY_KEY is sealed empty, MISSING_KEY not set')
  expect(refusal).toContain(`${PLATFORM_SLUG} machine config secret set EMPTY_KEY`)
  expect(refusal).toContain(`${PLATFORM_SLUG} machine config secret set MISSING_KEY`)
})
