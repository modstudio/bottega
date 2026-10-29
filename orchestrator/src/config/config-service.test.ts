import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { readHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { readMachineKey } from '../../../shared/machine-key-store.ts'
import { readTrustList } from '../../../shared/trust-list.ts'
import {
  applyLegacyEnvironmentSecretMigration,
  configHome,
  deleteEntry,
  deleteMachineEntry,
  getConfigEntry,
  machineInit,
  migrateLegacyEnvironmentSecrets,
  planRotation,
  restoreLegacyEnvironmentSecrets,
  sealedEmptyRefusal,
  sealSecretDecision,
  secretDeleteRemedy,
  secretEnvironmentDecision,
  secretSetRemedy,
  setConfigEntry,
  setEntry,
  setSecret,
} from './config-service.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('the declared home chooses machine and hosted keys and refuses an unsupported scope with its remedy', () => {
  expect(configHome('routing.cost_policy')).toBe('machine')
  expect(configHome('autonomy.preset')).toBe('user')
  expect(() => configHome('subscription.codex.monthly_usd', 'space')).toThrow(
    `refusing config key subscription.codex.monthly_usd in hosted space scope: its home is hosted user scope; write it with \`${PLATFORM_SLUG} machine config set subscription.codex.monthly_usd <value>\``,
  )
  expect(() => configHome('subscription.codex.monthly_usd', 'machine', 'get')).toThrow(
    `${PLATFORM_SLUG} machine config get subscription.codex.monthly_usd`,
  )
  expect(() => configHome('routing.cost_policy', 'space', 'get')).toThrow(
    `${PLATFORM_SLUG} machine config get --machine routing.cost_policy`,
  )
  expect(() => configHome('unknown.key')).toThrow(
    `accepted families are machine catalogue keys, autonomy.*, and subscription.<harness>.monthly_usd; inspect machine keys with \`${PLATFORM_SLUG} machine config list --machine\``,
  )
})

test('machine delete refuses an unknown key with every accepted family and the list remedy', () => {
  expect(() => deleteMachineEntry('unknown.key')).toThrow(
    `accepted families are machine catalogue keys and autonomy.*; inspect machine keys with \`${PLATFORM_SLUG} machine config list --machine\``,
  )
})

test('routing cost policy defaults to machine.toml and get reports the machine file source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-home-'))
  roots.push(root)
  const config = join(root, 'config')
  const env = { HOME: root, [CONFIG_HOME_ENV]: config }
  const client = {
    listEntries: async () => [{ key: 'routing.cost_policy', scope: 'space' }],
    getEntry: async () => {
      throw new Error('unexpected hosted read')
    },
    putEntry: async () => {
      throw new Error('unexpected hosted write')
    },
  } as unknown as ConfigClient

  await setConfigEntry(
    'routing.cost_policy',
    '{"enabled":false}',
    undefined,
    undefined,
    client,
    env,
  )
  await expect(
    getConfigEntry('routing.cost_policy', undefined, client, env),
  ).resolves.toMatchObject({
    key: 'routing.cost_policy',
    value: '{"enabled":false}',
    home: 'machine',
    source: 'machine.toml',
    ignoredHostedScopes: ['space'],
  })
})

test('machine-home set and get do not construct an unconfigured hosted client', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-recordless-'))
  roots.push(root)
  const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
  const notConfigured = () => {
    throw new ConfigClientError('not-configured', '/v1/config')
  }

  await expect(
    setConfigEntry(
      'routing.cost_policy',
      '{"enabled":false}',
      undefined,
      undefined,
      undefined,
      env,
      notConfigured,
    ),
  ).resolves.toMatchObject({ home: 'machine' })
  await expect(
    getConfigEntry('routing.cost_policy', undefined, undefined, env, notConfigured),
  ).resolves.toMatchObject({
    value: '{"enabled":false}',
    source: 'machine.toml',
    ignoredHostedScopes: [],
  })
})

test('effective machine get prefers the declared environment over machine.toml', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-env-'))
  roots.push(root)
  const config = join(root, 'config')
  const env = { HOME: root, [CONFIG_HOME_ENV]: config, BOTTEGA_HUB_PORT: '9100' }
  mkdirSync(config)
  writeFileSync(join(config, 'machine.toml'), '[hub]\nport = 9000\n')
  const client = { listEntries: async () => [] } as unknown as ConfigClient

  await expect(getConfigEntry('hub.port', undefined, client, env)).resolves.toMatchObject({
    value: '9100',
    source: 'environment BOTTEGA_HUB_PORT',
  })
})

test('explicit machine get reads machine.toml while the environment holds another value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-file-only-'))
  roots.push(root)
  const config = join(root, 'config')
  const env = { HOME: root, [CONFIG_HOME_ENV]: config, BOTTEGA_HUB_PORT: '9100' }
  mkdirSync(config)
  writeFileSync(join(config, 'machine.toml'), '[hub]\nport = 9000\n')

  await expect(getConfigEntry('hub.port', 'machine', undefined, env)).resolves.toMatchObject({
    value: '9000',
    source: 'machine.toml',
  })
})

test('subscription space refusal happens before any hosted write', async () => {
  const calls: string[] = []
  const client = {
    getEntry: async () => {
      calls.push('get')
      return {}
    },
    putEntry: async () => {
      calls.push('put')
      return {}
    },
  } as unknown as ConfigClient

  await expect(
    setConfigEntry('subscription.codex.monthly_usd', '200', 'space', undefined, client),
  ).rejects.toThrow('its home is hosted user scope')
  expect(calls).toEqual([])
})

test('invalid hosted subscription and autonomy values are refused before any write', async () => {
  const calls: string[] = []
  const client = {
    getEntry: async () => {
      calls.push('get')
      return {}
    },
    putEntry: async () => {
      calls.push('put')
      return {}
    },
  } as unknown as ConfigClient

  await expect(
    setConfigEntry('subscription.codex.monthly_usd', 'not-a-price', 'user', undefined, client),
  ).rejects.toThrow('value must be a non-negative number')
  await expect(
    setConfigEntry('autonomy.preset', 'sometimes', 'user', undefined, client),
  ).rejects.toThrow('value must be one of')
  expect(calls).toEqual([])
})

test('hosted autonomy get reports the machine value that outranks it locally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-autonomy-shadow-'))
  roots.push(root)
  const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
  const client = {
    getEntry: async () => ({
      key: 'autonomy.preset',
      environment: 'default',
      scope: 'user',
      value: 'manual',
      rowVersion: 1,
      updatedAt: '2026-10-29T00:00:00.000Z',
    }),
  } as unknown as ConfigClient
  await setConfigEntry('autonomy.preset', 'autonomous', 'machine', undefined, undefined, env)

  await expect(getConfigEntry('autonomy.preset', undefined, client, env)).resolves.toMatchObject({
    value: 'manual',
    source: 'hosted user scope',
    outrankingMachineValue: 'autonomous',
  })
})

test('secret set refuses an empty piped value and names the key and both remedies', () => {
  const decision = sealSecretDecision('EMPTY_KEY', '', 'user')
  expect(decision.kind).toBe('refuse')
  const refusal = decision.kind === 'refuse' ? decision.refusal : ''
  expect(refusal).toContain('EMPTY_KEY')
  expect(refusal).toContain('no value was sealed')
  expect(refusal).toContain('stdin')
  expect(refusal).toContain(secretSetRemedy('EMPTY_KEY', 'user'))
  expect(refusal).toContain(secretDeleteRemedy('EMPTY_KEY', 'user'))
  expect(refusal).not.toContain('--space')
})

test('a space-scope refusal names both repairs in the scope the set would have written', () => {
  expect(sealedEmptyRefusal('EMPTY_KEY', 'space')).toBe(
    `refusing to seal EMPTY_KEY: the value piped on stdin is empty, so no value was sealed\n` +
      `cleared by: pipe the value on stdin to \`${PLATFORM_SLUG} machine config secret set EMPTY_KEY --space\`, or remove the sealed value with \`${PLATFORM_SLUG} machine config secret delete EMPTY_KEY --space\``,
  )
  expect(sealSecretDecision('EMPTY_KEY', '\n', 'space')).toEqual({
    kind: 'refuse',
    refusal: sealedEmptyRefusal('EMPTY_KEY', 'space'),
  })
})

test('secret set refuses a value that is blank after its trailing newline', () => {
  for (const piped of ['\n', '\r\n', '   \n', '\t', '   ']) {
    expect(sealSecretDecision('EMPTY_KEY', piped, 'user').kind).toBe('refuse')
  }
})

test('the service refuses a blank value before touching the store', async () => {
  const calls: string[] = []
  const client = {
    currentDataKey: async () => {
      calls.push('currentDataKey')
      throw new Error('unexpected read')
    },
    getSecret: async () => {
      calls.push('getSecret')
      throw new Error('unexpected read')
    },
    putSecret: async () => {
      calls.push('putSecret')
      return {}
    },
  } as unknown as ConfigClient

  await expect(setSecret('EMPTY_KEY', '   \n', 'user', client)).rejects.toThrow(
    sealedEmptyRefusal('EMPTY_KEY', 'user'),
  )
  expect(calls).toEqual([])
})

test('secret set seals the value without one trailing newline and keeps its other characters', () => {
  expect(sealSecretDecision('TOKEN', 'fixture-token\n', 'user')).toEqual({
    kind: 'seal',
    value: 'fixture-token',
  })
  expect(sealSecretDecision('TOKEN', ' fixture-token ', 'user')).toEqual({
    kind: 'seal',
    value: ' fixture-token ',
  })
})

test('rotation plan re-seals only rows on older DEKs and retires each old DEK once', () => {
  const row = (key: string, dekId: string) => ({
    key,
    dekId,
    environment: 'default',
    scope: 'space' as const,
    rowVersion: 1,
    updatedAt: '2026-09-18T12:00:00.000Z',
  })
  const current = '01990000-0000-7000-8000-000000000003'
  const key = (id: string, version: number, retiredAt: string | null = null) => ({
    id,
    version,
    retiredAt,
    createdAt: '2026-09-18T12:00:00.000Z',
    wraps: [],
  })
  expect(
    planRotation(
      [row('a', 'old-b'), row('b', current), row('c', 'old-a'), row('d', 'old-b')],
      key(current, 3),
      [key('old-a', 1), key('old-b', 2), key(current, 3)],
    ),
  ).toEqual({
    reseal: [row('a', 'old-b'), row('c', 'old-a'), row('d', 'old-b')],
    retireDekIds: ['old-a', 'old-b'],
  })
})

test('sealed environment migration decision covers every resumable store state', () => {
  expect(secretEnvironmentDecision('old', null)).toEqual({
    kind: 'write-verify-delete',
    value: 'old',
  })
  expect(secretEnvironmentDecision('same', 'same')).toEqual({ kind: 'delete-old' })
  expect(secretEnvironmentDecision(null, 'new')).toEqual({ kind: 'done' })
  expect(secretEnvironmentDecision('old', 'new')).toEqual({ kind: 'refuse' })
})

test('a sealed environment migration refusal names the repair in the scope it would have migrated', async () => {
  const store = {
    scopes: async (oldName: string) => (oldName === 'ORCH_RECORD_URL' ? ['space' as const] : []),
    read: async (name: string) => (name === 'ORCH_RECORD_URL' ? 'old-value' : 'new-value'),
    write: async () => {},
    delete: async () => {},
  }

  const refusal = await applyLegacyEnvironmentSecretMigration(store).then(
    () => '',
    (error: Error) => error.message,
  )
  expect(refusal).toContain(
    `run \`${PLATFORM_SLUG} machine config secret delete ORCH_RECORD_URL --space\`, then re-run ${PLATFORM_SLUG} machine setup apply`,
  )
  expect(refusal).not.toContain('--scope')
})

test('a setup restore refusal names the repair without a flag the secret delete verb lacks', async () => {
  const { ConfigClientError } = await import('../../../shared/config-client.ts')
  const row = {
    key: 'ORCH_RECORD_URL',
    environment: 'default',
    scope: 'user' as const,
    dekId: 'dek',
    rowVersion: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
  }
  const client = {
    getSecret: async (name: string, scope: string) => {
      if (name === 'ORCH_RECORD_URL' && scope === 'user') return row
      throw new ConfigClientError('response', '/v1/config/secrets', 404)
    },
  } as unknown as ConfigClient

  const refusal = await restoreLegacyEnvironmentSecrets(
    [{ oldName: 'ORCH_RECORD_URL', newName: 'BOTTEGA_RECORD_URL', scope: 'user' }],
    client,
    { plaintext: async () => new TextEncoder().encode('value') },
  ).then(
    () => '',
    (error: Error) => error.message,
  )
  expect(refusal).toContain(
    `run \`${PLATFORM_SLUG} machine config secret delete ORCH_RECORD_URL\`, then re-run ${PLATFORM_SLUG} machine setup restore`,
  )
  expect(refusal).not.toContain('--scope')
})

test('sealed environment migration verifies the decoded write before deleting the old name', async () => {
  const values = new Map([['user:ORCH_RECORD_URL', 'secret-value']])
  const calls: string[] = []
  const store = {
    scopes: async (oldName: string) => (oldName === 'ORCH_RECORD_URL' ? ['user' as const] : []),
    read: async (name: string, scope: string) => values.get(`${scope}:${name}`) ?? null,
    write: async (name: string, value: string, scope: string) => {
      calls.push(`write ${scope}:${name}`)
      values.set(`${scope}:${name}`, value)
    },
    delete: async (name: string, scope: string) => {
      calls.push(`delete ${scope}:${name}`)
      values.delete(`${scope}:${name}`)
    },
  }
  await applyLegacyEnvironmentSecretMigration(store)
  expect(calls).toEqual(['write user:BOTTEGA_RECORD_URL', 'delete user:ORCH_RECORD_URL'])

  values.set('user:ORCH_RECORD_URL', 'secret-value')
  values.delete('user:BOTTEGA_RECORD_URL')
  calls.length = 0
  store.write = async (name: string, _value: string, scope: string) => {
    calls.push(`write ${scope}:${name}`)
    values.set(`${scope}:${name}`, 'failed-readback')
  }
  await expect(applyLegacyEnvironmentSecretMigration(store)).rejects.toThrow('did not verify')
  expect(calls).toEqual(['write user:BOTTEGA_RECORD_URL'])
  expect(values.get('user:ORCH_RECORD_URL')).toBe('secret-value')
})

test('production sealed migration wires listed scopes, not-found reads, decoding, write verification, and delete order', async () => {
  const values = new Map([['user:ORCH_RECORD_URL', new TextEncoder().encode('decoded-value')]])
  const calls: string[] = []
  const row = (key: string) => ({
    key,
    environment: 'default',
    scope: 'user' as const,
    dekId: 'dek',
    rowVersion: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
  })
  const client = {
    listSecrets: async () => [row('ORCH_RECORD_URL')],
    getSecret: async (name: string, scope: string) => {
      if (!values.has(`${scope}:${name}`)) {
        throw new (await import('../../../shared/config-client.ts')).ConfigClientError(
          'response',
          '/v1/config/secrets',
          404,
        )
      }
      return row(name)
    },
  } as unknown as ConfigClient

  const migrated = await migrateLegacyEnvironmentSecrets(client, {
    plaintext: async (_client, secret) => values.get(`${secret.scope}:${secret.key}`)!,
    write: async (name, value, scope) => {
      calls.push(`write ${scope}:${name}=${value}`)
      values.set(`${scope}:${name}`, new TextEncoder().encode(value))
    },
    delete: async (name, scope) => {
      calls.push(`delete ${scope}:${name}`)
      values.delete(`${scope}:${name}`)
    },
  })

  expect(migrated).toEqual([
    { oldName: 'ORCH_RECORD_URL', newName: 'BOTTEGA_RECORD_URL', scope: 'user' },
  ])
  expect(calls).toEqual([
    'write user:BOTTEGA_RECORD_URL=decoded-value',
    'delete user:ORCH_RECORD_URL',
  ])
})

test('sealed-secret restore renames only recorded names back without persisting plaintext', async () => {
  const values = new Map([['user:BOTTEGA_RECORD_URL', new TextEncoder().encode('decoded-value')]])
  const calls: string[] = []
  const row = (key: string) => ({
    key,
    environment: 'default',
    scope: 'user' as const,
    dekId: 'dek',
    rowVersion: 1,
    updatedAt: '2026-10-23T00:00:00.000Z',
  })
  const client = {
    getSecret: async (name: string, scope: string) => {
      if (!values.has(`${scope}:${name}`)) {
        throw new (await import('../../../shared/config-client.ts')).ConfigClientError(
          'response',
          '/v1/config/secrets',
          404,
        )
      }
      return row(name)
    },
  } as unknown as ConfigClient

  await restoreLegacyEnvironmentSecrets(
    [{ oldName: 'ORCH_RECORD_URL', newName: 'BOTTEGA_RECORD_URL', scope: 'user' }],
    client,
    {
      plaintext: async (_client, secret) => values.get(`${secret.scope}:${secret.key}`)!,
      write: async (name, value, scope) => {
        calls.push(`write ${scope}:${name}`)
        values.set(`${scope}:${name}`, new TextEncoder().encode(value))
      },
      delete: async (name, scope) => {
        calls.push(`delete ${scope}:${name}`)
        values.delete(`${scope}:${name}`)
      },
    },
  )

  expect(calls).toEqual(['write user:ORCH_RECORD_URL', 'delete user:BOTTEGA_RECORD_URL'])
  expect(values.has('user:ORCH_RECORD_URL')).toBe(true)
  expect(values.has('user:BOTTEGA_RECORD_URL')).toBe(false)
})

test('rotation plan retires an unreferenced old key and does so on a converged rerun', () => {
  const current = {
    id: 'current',
    version: 3,
    retiredAt: null,
    createdAt: '2026-09-18T12:00:00.000Z',
    wraps: [],
  }
  expect(
    planRotation([], current, [
      { ...current, id: 'unused-old', version: 1 },
      { ...current, id: 'already-retired', version: 2, retiredAt: '2026-09-18T13:00:00.000Z' },
      current,
    ]),
  ).toEqual({ reseal: [], retireDekIds: ['unused-old'] })
})

test('entry writes and deletes pass explicit expected row versions without a prior read', async () => {
  const writes: unknown[] = []
  const client = {
    getEntry: async () => {
      throw new Error('unexpected read')
    },
    putEntry: async (key: string, input: unknown) => {
      writes.push(['put', key, input])
      return { key }
    },
    deleteEntry: async (key: string, input: unknown) => {
      writes.push(['delete', key, input])
      return { deleted: true }
    },
  } as unknown as ConfigClient

  await setEntry('autonomy.preset', 'guided', 'user', 4, client)
  await deleteEntry('autonomy.stage.review', 'user', 7, client)

  expect(writes).toEqual([
    [
      'put',
      'autonomy.preset',
      {
        scope: 'user',
        environment: 'default',
        value: 'guided',
        expectedRowVersion: 4,
      },
    ],
    [
      'delete',
      'autonomy.stage.review',
      { scope: 'user', environment: 'default', expectedRowVersion: 7 },
    ],
  ])
})

test('a hosted ship-to write removes the stored alias with its own row version', async () => {
  const writes: unknown[] = []
  const client = {
    getEntry: async (key: string) => ({ key, rowVersion: 9 }),
    putEntry: async (key: string, input: unknown) => {
      writes.push(['put', key, input])
      return { key }
    },
    deleteEntry: async (key: string, input: unknown) => {
      writes.push(['delete', key, input])
      return { deleted: true }
    },
  } as unknown as ConfigClient

  await setEntry('autonomy.ship-to', 'production', 'user', null, client)

  expect(writes.at(-1)).toEqual([
    'delete',
    'autonomy.release',
    { scope: 'user', environment: 'default', expectedRowVersion: 9 },
  ])
})

test('machine init converges with an existing key, pin, space, and registration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-init-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  const registrations: string[] = []
  const spaceId = '01990000-0000-7000-8000-000000000001'
  const userId = '01990000-0000-7000-8000-000000000002'
  let identity = { user: { id: userId }, activeSpaceId: spaceId }
  const client = {
    whoami: async () => identity,
    registerMachineKey: async (keyId: string) => {
      registrations.push(keyId)
      return {}
    },
  } as unknown as ConfigClient

  const first = await machineInit('fixture', client, env)
  const privateKey = readMachineKey(env)?.privateKey
  await expect(machineInit('fixture', client, env)).resolves.toBe(first)
  expect(readMachineKey(env)?.privateKey).toEqual(privateKey)
  expect(Object.keys(await readTrustList(env))).toEqual([first])
  expect(readHostedConfigIdentity(env)).toEqual({ spaceId, userId })
  expect(registrations).toEqual([first, first])

  identity = { ...identity, activeSpaceId: '01990000-0000-7000-8000-000000000003' }
  await expect(machineInit('fixture', client, env)).rejects.toThrow('switch back')
  expect(readHostedConfigIdentity(env)).toEqual({ spaceId, userId })
  expect(registrations).toEqual([first, first])

  identity = {
    user: { id: '01990000-0000-7000-8000-000000000004' },
    activeSpaceId: spaceId,
  }
  await expect(machineInit('fixture', client, env)).rejects.toThrow('sign back in')
  expect(readHostedConfigIdentity(env)).toEqual({ spaceId, userId })
  expect(registrations).toEqual([first, first])
})
