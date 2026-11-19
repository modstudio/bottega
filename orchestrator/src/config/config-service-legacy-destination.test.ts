import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { writeHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { LEGACY_ENVIRONMENT_SECRET_NAMES } from '../setup/environment-name-migration.ts'
import {
  migrateLegacyEnvironmentSecrets,
  restoreLegacyEnvironmentSecrets,
} from './config-service.ts'

const roots: string[] = []
const [OLD_NAME, NEW_NAME] = LEGACY_ENVIRONMENT_SECRET_NAMES[0]!
const previousConfigHome = process.env.BOTTEGA_CONFIG_HOME
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousConfigHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
  else process.env.BOTTEGA_CONFIG_HOME = previousConfigHome
})

function pinTestHostedIdentity() {
  const root = mkdtempSync(join(tmpdir(), 'config-pinned-'))
  roots.push(root)
  process.env.BOTTEGA_CONFIG_HOME = root
  const spaceId = '01990000-0000-7000-8000-000000000091'
  const userId = '01990000-0000-7000-8000-000000000092'
  writeHostedConfigIdentity({ spaceId, userId })
  return {
    spaceId,
    whoami: {
      user: { id: userId },
      activeSpaceId: spaceId,
      personalSpaceId: '01990000-0000-7000-8000-000000000099',
      memberships: [],
    },
  }
}

test('a setup restore refusal names the repair without a flag the secret delete verb lacks', async () => {
  const pinned = pinTestHostedIdentity()
  const row = {
    key: OLD_NAME,
    environment: 'default',
    scope: 'user' as const,
    dekId: 'dek',
    rowVersion: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
  }
  const client = {
    whoami: async () => pinned.whoami,
    getSecret: async (name: string, scope: string) => {
      if (name === OLD_NAME && scope === 'user') return row
      throw new ConfigClientError('response', '/v1/config/secrets', 404)
    },
  } as unknown as ConfigClient

  const refusal = await restoreLegacyEnvironmentSecrets(
    [{ oldName: OLD_NAME, newName: NEW_NAME, scope: 'user' }],
    client,
    { plaintext: async () => new TextEncoder().encode('value') },
  ).then(
    () => '',
    (error: Error) => error.message,
  )
  expect(refusal).toContain(
    `run \`${PLATFORM_SLUG} machine config secret delete ${OLD_NAME}\`, then re-run ${PLATFORM_SLUG} machine setup restore`,
  )
  expect(refusal).not.toContain('--scope')
})

test('production sealed migration uses the pinned destination for every read and write', async () => {
  const pinned = pinTestHostedIdentity()
  const values = new Map([[`user:${OLD_NAME}`, new TextEncoder().encode('decoded-value')]])
  const calls: string[] = []
  const destinations: Array<[string, string | undefined]> = []
  const row = (key: string) => ({
    key,
    environment: 'default',
    scope: 'user' as const,
    dekId: 'dek',
    rowVersion: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
  })
  const client = {
    listSecrets: async (_environment: string, destination: { destinationSpaceId?: string }) => {
      destinations.push(['list', destination.destinationSpaceId])
      return [row(OLD_NAME)]
    },
    whoami: async () => pinned.whoami,
    getSecret: async (
      name: string,
      scope: string,
      _environment: string,
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.push(['read', destination.destinationSpaceId])
      if (!values.has(`${scope}:${name}`))
        throw new ConfigClientError('response', '/v1/config/secrets', 404)
      return row(name)
    },
  } as unknown as ConfigClient

  const migrated = await migrateLegacyEnvironmentSecrets(client, {
    plaintext: async (_client, secret) => values.get(`${secret.scope}:${secret.key}`)!,
    write: async (name, value, scope, _client, destination) => {
      destinations.push(['write', destination.destinationSpaceId])
      calls.push(`write ${scope}:${name}=${value}`)
      values.set(`${scope}:${name}`, new TextEncoder().encode(value))
    },
    delete: async (name, scope, _client, destination) => {
      destinations.push(['delete', destination.destinationSpaceId])
      calls.push(`delete ${scope}:${name}`)
      values.delete(`${scope}:${name}`)
    },
  })

  expect(migrated).toEqual([{ oldName: OLD_NAME, newName: NEW_NAME, scope: 'user' }])
  expect(calls).toEqual([`write user:${NEW_NAME}=decoded-value`, `delete user:${OLD_NAME}`])
  expect(new Set(destinations.map(([, destination]) => destination))).toEqual(
    new Set([pinned.spaceId]),
  )
  expect(new Set(destinations.map(([operation]) => operation))).toEqual(
    new Set(['list', 'read', 'write', 'delete']),
  )
})

test('sealed environment migration refuses a non-user scope before any write', async () => {
  const pinned = pinTestHostedIdentity()
  const calls: string[] = []
  const client = {
    whoami: async () => pinned.whoami,
    listSecrets: async () => [
      {
        key: OLD_NAME,
        environment: 'default',
        scope: 'space' as const,
        dekId: 'dek',
        rowVersion: 1,
        updatedAt: '2026-10-23T00:00:00.000Z',
      },
    ],
  } as unknown as ConfigClient

  const refusal = await migrateLegacyEnvironmentSecrets(client, {
    write: async () => calls.push('write'),
    delete: async () => calls.push('delete'),
  }).then(
    () => '',
    (error: Error) => error.message,
  )

  expect(refusal).toContain(`${OLD_NAME} in space scope`)
  expect(refusal).toContain(`${PLATFORM_SLUG} machine config secret set ${OLD_NAME} --space <slug>`)
  expect(calls).toEqual([])
})

test('sealed-secret restore uses the pinned destination for every read and write', async () => {
  const pinned = pinTestHostedIdentity()
  const values = new Map([[`user:${NEW_NAME}`, new TextEncoder().encode('decoded-value')]])
  const calls: string[] = []
  const destinations: Array<[string, string | undefined]> = []
  const row = (key: string) => ({
    key,
    environment: 'default',
    scope: 'user' as const,
    dekId: 'dek',
    rowVersion: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
  })
  const client = {
    whoami: async () => pinned.whoami,
    getSecret: async (
      name: string,
      scope: string,
      _environment: string,
      destination: { destinationSpaceId?: string },
    ) => {
      destinations.push(['read', destination.destinationSpaceId])
      if (!values.has(`${scope}:${name}`))
        throw new ConfigClientError('response', '/v1/config/secrets', 404)
      return row(name)
    },
  } as unknown as ConfigClient

  await restoreLegacyEnvironmentSecrets(
    [{ oldName: OLD_NAME, newName: NEW_NAME, scope: 'user' }],
    client,
    {
      plaintext: async (_client, secret) => values.get(`${secret.scope}:${secret.key}`)!,
      write: async (name, value, scope, _client, destination) => {
        destinations.push(['write', destination.destinationSpaceId])
        calls.push(`write ${scope}:${name}`)
        values.set(`${scope}:${name}`, new TextEncoder().encode(value))
      },
      delete: async (name, scope, _client, destination) => {
        destinations.push(['delete', destination.destinationSpaceId])
        calls.push(`delete ${scope}:${name}`)
        values.delete(`${scope}:${name}`)
      },
    },
  )

  expect(calls).toEqual([`write user:${OLD_NAME}`, `delete user:${NEW_NAME}`])
  expect(values.has(`user:${OLD_NAME}`)).toBe(true)
  expect(values.has(`user:${NEW_NAME}`)).toBe(false)
  expect(new Set(destinations.map(([, destination]) => destination))).toEqual(
    new Set([pinned.spaceId]),
  )
  expect(new Set(destinations.map(([operation]) => operation))).toEqual(
    new Set(['read', 'write', 'delete']),
  )
})
