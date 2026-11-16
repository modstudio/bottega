import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { readMachineKey, writeMachineKey } from '../../../shared/machine-key-store.ts'
import * as machineSigningKey from '../../../shared/machine-signing-key.ts'
import {
  generateMachineKeyPair,
  KEY_SIZE,
  openValue,
  sealClaimChallenge,
  unwrapDataKey,
} from '../../../shared/secret-envelope.ts'
import { readTrustList } from '../../../shared/trust-list.ts'
import {
  decodeTrustLogEntry,
  trustLogEntryHash,
  verifyTrustLog,
} from '../../../shared/trust-log.ts'
import { readRememberedTrustLogHead } from '../../../shared/trust-log-head.ts'
import {
  applyLegacyEnvironmentSecretMigration,
  claimCurrentMachineKey,
  configHome,
  deleteEntry,
  deleteMachineEntry,
  getConfigEntry,
  machineInit,
  machineRevoke,
  machineTrust,
  migrateLegacyEnvironmentSecrets,
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
import { rotationFixture } from './config-service-rotation.fixture.ts'
import { planRotation } from './config-service-rotation-policy.ts'
import { readCachedDisplayTimezone, writeCachedDisplayTimezone } from './display-timezone-cache.ts'

const roots: string[] = []
let previousConfigHome: string | undefined, previousKeystore: string | undefined
beforeEach(() => {
  previousConfigHome = process.env.BOTTEGA_CONFIG_HOME
  previousKeystore = process.env.BOTTEGA_KEYSTORE
})
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousConfigHome === undefined) delete process.env.BOTTEGA_CONFIG_HOME
  else process.env.BOTTEGA_CONFIG_HOME = previousConfigHome
  if (previousKeystore === undefined) delete process.env.BOTTEGA_KEYSTORE
  else process.env.BOTTEGA_KEYSTORE = previousKeystore
})

test('the declared home chooses machine and hosted keys and refuses an unsupported scope with its remedy', () => {
  expect(configHome('routing.cost_policy')).toBe('machine')
  expect(configHome('autonomy.preset')).toBe('user')
  expect(configHome('display.timezone')).toBe('user')
  expect(() => configHome('display.timezone', 'machine')).toThrow('its home is hosted user scope')
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
    `accepted families are machine catalogue keys, display.timezone, autonomy.*, and subscription.<harness>.monthly_usd; inspect machine keys with \`${PLATFORM_SLUG} machine config list --machine\``,
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
  const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
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

test('display timezone validates before writing and a successful set refreshes the user cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-display-timezone-'))
  roots.push(root)
  const env = { HOME: root, BOTTEGA_STATE_HOME: join(root, 'state') }
  const calls: string[] = []
  const client = {
    whoami: async () => ({ personalSpaceId: 'space-personal', memberships: [] }),
    putEntry: async (key: string, input: { value: string }) => {
      calls.push(`${key}=${input.value}`)
      return {
        key,
        scope: 'user',
        environment: 'default',
        value: input.value,
        rowVersion: 1,
        updatedAt: '2026-11-15T12:00:00.000Z',
      }
    },
  } as unknown as ConfigClient

  await expect(
    setConfigEntry('display.timezone', 'Mars/Olympus', undefined, null, client, env),
  ).rejects.toThrow(
    `refusing display.timezone Mars/Olympus: not an IANA time zone; e.g. ${PLATFORM_SLUG} machine config set display.timezone America/New_York`,
  )
  expect(calls).toEqual([])

  await expect(
    setConfigEntry('display.timezone', 'America/New_York', undefined, null, client, env),
  ).resolves.toMatchObject({ home: 'user', value: 'America/New_York' })
  expect(readCachedDisplayTimezone(env)).toBe('America/New_York')
})

test('display timezone get treats an invalid hosted value as unset and clears the cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-invalid-display-timezone-'))
  roots.push(root)
  const env = { HOME: root, BOTTEGA_STATE_HOME: join(root, 'state') }
  writeCachedDisplayTimezone('America/New_York', env)
  const client = {
    getEntry: async () => ({
      key: 'display.timezone',
      scope: 'user',
      environment: 'default',
      value: 'Mars/Olympus',
      rowVersion: 1,
      updatedAt: '2026-11-15T12:00:00.000Z',
    }),
  } as unknown as ConfigClient

  await expect(getConfigEntry('display.timezone', undefined, client, env)).rejects.toThrow(
    'hosted user scope has no value for display.timezone',
  )
  expect(readCachedDisplayTimezone(env)).toBeNull()
})

test('display timezone cache failures warn without failing successful hosted set and get', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-display-cache-failure-'))
  roots.push(root)
  const stateFile = join(root, 'state-file')
  writeFileSync(stateFile, 'not a directory')
  const env = { HOME: root, BOTTEGA_STATE_HOME: stateFile }
  const row = {
    key: 'display.timezone',
    scope: 'user' as const,
    environment: 'default',
    value: 'America/New_York',
    rowVersion: 1,
    updatedAt: '2026-11-15T12:00:00.000Z',
  }
  const client = {
    whoami: async () => ({ personalSpaceId: 'space-personal', memberships: [] }),
    putEntry: async () => row,
    getEntry: async () => row,
  } as unknown as ConfigClient
  const warning = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      setConfigEntry('display.timezone', row.value, undefined, null, client, env),
    ).resolves.toMatchObject({ value: row.value })
    await expect(getConfigEntry('display.timezone', undefined, client, env)).resolves.toMatchObject(
      {
        value: row.value,
      },
    )
    expect(warning).toHaveBeenCalledTimes(2)
    expect(warning.mock.calls[0]?.[0]).toStartWith(
      'warning: could not refresh display time zone cache:',
    )
  } finally {
    warning.mockRestore()
  }
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

  await expect(
    setSecret('EMPTY_KEY', '   \n', 'user', client, {
      destination: { destinationSpaceId: 'space-1' },
    }),
  ).rejects.toThrow(sealedEmptyRefusal('EMPTY_KEY', 'user'))
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

test('the next secret operation rotates once only when a machine revocation is newer', async () => {
  const newer = await rotationFixture(roots, '2026-06-01T00:00:00.000Z')
  await setSecret('TOKEN', 'first', 'space', newer.client, {
    destination: { destinationSpaceId: newer.spaceId },
  })
  await setSecret('TOKEN', 'second', 'space', newer.client, {
    destination: { destinationSpaceId: newer.spaceId },
  })
  expect(newer.created).toHaveLength(1)
  expect(newer.retired).toEqual(['01990000-0000-7000-8000-000000000003'])

  const older = await rotationFixture(roots, '2025-06-01T00:00:00.000Z')
  await setSecret('TOKEN', 'unchanged', 'space', older.client, {
    destination: { destinationSpaceId: older.spaceId },
  })
  expect(older.created).toEqual([])
  expect(older.retired).toEqual([])
})

test('rotation excludes a record-revoked key that remains in the machine trust log', async () => {
  const fixture = await rotationFixture(
    roots,
    '2026-06-01T00:00:00.000Z',
    false,
    false,
    false,
    true,
  )
  await setSecret('TOKEN', 'rotated', 'space', fixture.client, {
    destination: { destinationSpaceId: fixture.spaceId },
  })

  expect(fixture.current().wraps.map((wrap) => wrap.recipientKeyId)).not.toContain(
    fixture.otherKeyId,
  )
  expect(fixture.current().wraps).toHaveLength(1)
})

test('machine revoke rotates through the shared rotation operation', async () => {
  const fixture = await rotationFixture(roots, null)
  await machineRevoke(fixture.otherKeyId, fixture.client)
  expect(fixture.created).toHaveLength(1)
  expect(fixture.retired).toEqual(['01990000-0000-7000-8000-000000000003'])
})

test('machine revoke appends and remembers a verified trust log revocation before record revoke', async () => {
  const fixture = await rotationFixture(roots, null, false, false, false, true)
  await machineRevoke(fixture.otherKeyId, fixture.client)

  const appended = fixture.appendedTrustLogEntry()
  expect(decodeTrustLogEntry(appended!).body).toEqual({ kind: 'revoke', keyId: fixture.otherKeyId })
  const state = verifyTrustLog([...fixture.trustLog, appended!], { spaceId: fixture.spaceId })
  expect(state.keys.has(fixture.otherKeyId)).toBe(false)
  expect(readRememberedTrustLogHead(fixture.spaceId)).toEqual(trustLogEntryHash(appended!))
  expect(fixture.recordCallOrder).toEqual(['appendTrustLogEntry', 'revokeMachineKey'])
})

test('machine revoke converges the trust log when the record already shows the key revoked', async () => {
  const fixture = await rotationFixture(
    roots,
    '2026-06-01T00:00:00.000Z',
    false,
    false,
    false,
    true,
  )
  await machineRevoke(fixture.otherKeyId, fixture.client)

  expect(decodeTrustLogEntry(fixture.appendedTrustLogEntry()!).body).toEqual({
    kind: 'revoke',
    keyId: fixture.otherKeyId,
  })
})

test('machine revoke resumes re-sealing older rows without creating another data key', async () => {
  const fixture = await rotationFixture(roots, '2025-06-01T00:00:00.000Z', true)
  await expect(machineRevoke(fixture.otherKeyId, fixture.client)).resolves.toEqual([
    'space:default:TOKEN',
  ])
  expect(fixture.created).toEqual([])
  expect(fixture.retired).toEqual(['01990000-0000-7000-8000-000000000003'])
  expect(fixture.putSecretDestinations).toEqual([
    { destinationSpaceId: fixture.spaceId, projectId: null },
  ])
})

test('rotation reads and writes space and project-bound rows in their own slots', async () => {
  const fixture = await rotationFixture(roots, '2025-06-01T00:00:00.000Z', true, true)
  await machineRevoke(fixture.otherKeyId, fixture.client)

  expect(fixture.secrets()).toEqual([
    expect.objectContaining({ projectId: null, dekId: fixture.current().id, rowVersion: 2 }),
    expect.objectContaining({
      projectId: '01990000-0000-7000-8000-000000000005',
      dekId: fixture.current().id,
      rowVersion: 2,
    }),
  ])
})

test('machine trust after a newer revocation rotates once and does not duplicate its wrap', async () => {
  const fixture = await rotationFixture(roots, '2026-06-01T00:00:00.000Z')
  await machineTrust(
    fixture.recipientKeyId,
    fixture.recipientPublicKey,
    'recipient',
    { spaceId: fixture.spaceId, slug: 'fixture' },
    fixture.client,
  )
  expect(fixture.created).toHaveLength(1)
  expect(fixture.current().version).toBe(2)
  expect(fixture.retired).toEqual(['01990000-0000-7000-8000-000000000003'])
  expect(
    fixture.current().wraps.filter((wrap) => wrap.recipientKeyId === fixture.recipientKeyId),
  ).toHaveLength(1)
})

test('machine trust names machine approve when an anchored log omits the target key', async () => {
  const fixture = await rotationFixture(roots, null, false, false, false, true)

  await expect(
    machineTrust(
      fixture.recipientKeyId,
      fixture.recipientPublicKey,
      'recipient',
      { spaceId: fixture.spaceId, slug: 'fixture' },
      fixture.client,
    ),
  ).rejects.toThrow(
    `the space's machine trust log does not list ${fixture.recipientKeyId}\ncleared by: on that machine run \`${PLATFORM_SLUG} machine join --space fixture\`, then on a machine the trust log already trusts run \`${PLATFORM_SLUG} machine approve <code>\` with the code it prints`,
  )
  expect((await readTrustList())[fixture.recipientKeyId]).toBeUndefined()
})

test('machine trust rotation keeps a selected-space user secret bound to its user', async () => {
  const fixture = await rotationFixture(roots, '2026-06-01T00:00:00.000Z', true, false, true)
  await machineTrust(
    fixture.recipientKeyId,
    fixture.recipientPublicKey,
    'recipient',
    { spaceId: fixture.spaceId, slug: 'fixture' },
    fixture.client,
  )
  const row = fixture.secrets()[0]!
  const machine = readMachineKey()!
  const machineId = await machineKeyId(machine.publicKey)
  const key = fixture.current()
  const wrap = key.wraps.find((candidate) => candidate.recipientKeyId === machineId)!
  const sender = (await readTrustList())[wrap.senderKeyId]!
  const dek = await unwrapDataKey({
    enc: Buffer.from(wrap.enc, 'base64url'),
    ciphertext: Buffer.from(wrap.ciphertext, 'base64url'),
    wrapContext: { spaceId: fixture.spaceId, dekId: key.id, dekVersion: key.version },
    recipientPrivateKey: machine.privateKey,
    senderPublicKey: Buffer.from(sender.public_key, 'base64url'),
    trustedSenderKeyIds: new Set([wrap.senderKeyId]),
  })
  expect(
    new TextDecoder().decode(
      openValue({
        envelope: Buffer.from(row.envelope, 'base64url'),
        dek,
        valueContext: {
          spaceId: fixture.spaceId,
          userId: '01990000-0000-7000-8000-000000000002',
          keyName: row.key,
          environment: row.environment,
          dekId: row.dekId,
          rowVersion: row.rowVersion,
        },
      }),
    ),
  ).toBe('resume-me')
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
    whoami: async () => ({
      personalSpaceId: 'space-personal',
      memberships: [],
    }),
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
    write: async (name, value, scope, _client, destination) => {
      calls.push(`write ${scope}:${name}=${value}`)
      calls.push(`write destination=${destination.destinationSpaceId}`)
      values.set(`${scope}:${name}`, new TextEncoder().encode(value))
    },
    delete: async (name, scope, _client, destination) => {
      calls.push(`delete ${scope}:${name}`)
      calls.push(`delete destination=${destination.destinationSpaceId}`)
      values.delete(`${scope}:${name}`)
    },
  })

  expect(migrated).toEqual([
    { oldName: 'ORCH_RECORD_URL', newName: 'BOTTEGA_RECORD_URL', scope: 'user' },
  ])
  expect(calls).toEqual([
    'write user:BOTTEGA_RECORD_URL=decoded-value',
    'write destination=space-personal',
    'delete user:ORCH_RECORD_URL',
    'delete destination=space-personal',
  ])
})

test('sealed environment migration refuses a non-user scope before any write', async () => {
  const calls: string[] = []
  const client = {
    listSecrets: async () => [
      {
        key: 'ORCH_RECORD_URL',
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

  expect(refusal).toContain('ORCH_RECORD_URL in space scope')
  expect(refusal).toContain(
    `${PLATFORM_SLUG} machine config secret set ORCH_RECORD_URL --space <slug>`,
  )
  expect(calls).toEqual([])
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
    whoami: async () => ({
      personalSpaceId: 'space-personal',
      memberships: [],
    }),
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

test('entry writes and deletes name their destination space and pass explicit row versions without a prior read', async () => {
  const writes: unknown[] = []
  const client = {
    getEntry: async () => {
      throw new Error('unexpected read')
    },
    putEntry: async (key: string, input: unknown, destination: unknown) => {
      writes.push(['put', key, input, destination])
      return { key }
    },
    deleteEntry: async (key: string, input: unknown, destination: unknown) => {
      writes.push(['delete', key, input, destination])
      return { deleted: true }
    },
  } as unknown as ConfigClient

  const destination = { destinationSpaceId: 'space-1' }
  await setEntry('autonomy.preset', 'guided', 'user', 4, client, destination)
  await deleteEntry('autonomy.stage.review', 'user', 7, client, destination)

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
      { destinationSpaceId: 'space-1' },
    ],
    [
      'delete',
      'autonomy.stage.review',
      {
        scope: 'user',
        environment: 'default',
        expectedRowVersion: 7,
      },
      { destinationSpaceId: 'space-1' },
    ],
  ])
})

test('a hosted ship-to write removes the stored alias with its own row version', async () => {
  const writes: unknown[] = []
  const client = {
    getEntry: async (key: string) => ({ key, rowVersion: 9 }),
    putEntry: async (key: string, input: unknown, destination: unknown) => {
      writes.push(['put', key, input, destination])
      return { key }
    },
    deleteEntry: async (key: string, input: unknown, destination: unknown) => {
      writes.push(['delete', key, input, destination])
      return { deleted: true }
    },
  } as unknown as ConfigClient

  const destination = { destinationSpaceId: 'space-1' }
  await setEntry('autonomy.ship-to', 'production', 'user', null, client, destination)

  expect(writes.at(-1)).toEqual([
    'delete',
    'autonomy.release',
    { scope: 'user', environment: 'default', expectedRowVersion: 9 },
    destination,
  ])
})

test('machine init backs up and replaces a revoked local identity before registering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-init-revoked-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  const spaceId = '01990000-0000-7000-8000-000000000031'
  const userId = '01990000-0000-7000-8000-000000000032'
  const registrations: string[] = []
  let revokedKeyId: string | null = null
  const client = {
    whoami: async () => ({ user: { id: userId }, activeSpaceId: spaceId }),
    listMachineKeys: async () =>
      revokedKeyId ? [{ keyId: revokedKeyId, revokedAt: '2026-11-03T00:00:00.000Z' }] : [],
    registerMachineKey: async (keyId: string) => {
      registrations.push(keyId)
      return { userId }
    },
  } as unknown as ConfigClient

  const oldKeyId = await machineInit(spaceId, 'fixture', client, env)
  const oldPrivateKey = readMachineKey(env)?.privateKey
  const oldSigningPrivateKey = machineSigningKey.readMachineSigningKey(env)?.privateKey
  revokedKeyId = oldKeyId
  const newKeyId = await machineInit(spaceId, 'fixture', client, env)

  expect(newKeyId).not.toBe(oldKeyId)
  expect(readMachineKey(env)?.privateKey).not.toEqual(oldPrivateKey)
  expect(machineSigningKey.readMachineSigningKey(env)?.privateKey).not.toEqual(oldSigningPrivateKey)
  expect(readFileSync(join(root, 'machine-key-revoked', oldKeyId), 'utf8').trim()).toBe(
    Buffer.from(oldPrivateKey!).toString('base64url'),
  )
  expect(
    readFileSync(join(root, 'machine-key-revoked', `${oldKeyId}.signing`), 'utf8').trim(),
  ).toBe(Buffer.from(oldSigningPrivateKey!).toString('base64url'))
  expect(registrations).toEqual([oldKeyId, newKeyId])
  expect(Object.keys(await readTrustList(env))).toEqual([newKeyId])
})

test('machine init proves possession exactly once only when registration is unowned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-init-claim-'))
  roots.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  const spaceId = '01990000-0000-7000-8000-000000000011'
  const userId = '01990000-0000-7000-8000-000000000012'
  const sender = await generateMachineKeyPair()
  const nonce = crypto.getRandomValues(new Uint8Array(KEY_SIZE))
  const calls: string[] = []
  let registeredOwner: string | null = null
  let registeredKeyId: string | null = null
  const client = {
    whoami: async () => ({ user: { id: userId }, activeSpaceId: spaceId }),
    listMachineKeys: async () =>
      registeredKeyId ? [{ keyId: registeredKeyId, revokedAt: null }] : [],
    registerMachineKey: async (keyId: string) => {
      registeredKeyId = keyId
      return { userId: registeredOwner }
    },
    createMachineKeyClaimChallenge: async (keyId: string) => {
      calls.push('challenge')
      const recipient = readMachineKey(env)
      if (!recipient) throw new Error('test machine key was not stored')
      const sealed = await sealClaimChallenge({
        nonce,
        spaceId,
        keyId,
        senderPrivateKey: sender.privateKey,
        senderPublicKey: sender.publicKey,
        recipientPublicKey: recipient.publicKey,
      })
      return {
        challengeId: 'claim-a',
        enc: Buffer.from(sealed.enc).toString('base64url'),
        ciphertext: Buffer.from(sealed.ciphertext).toString('base64url'),
        senderPublicKey: Buffer.from(sender.publicKey).toString('base64url'),
      }
    },
    claimMachineKey: async (_keyId: string, challengeId: string, opened: string) => {
      calls.push('claim')
      expect(challengeId).toBe('claim-a')
      expect(new Uint8Array(Buffer.from(opened, 'base64url'))).toEqual(nonce)
      return { claimed: true as const }
    },
  } as unknown as ConfigClient

  await machineInit(spaceId, 'unowned', client, env)
  expect(calls).toEqual(['challenge', 'claim'])

  registeredOwner = userId
  await machineInit(spaceId, 'owned', client, env)
  expect(calls).toEqual(['challenge', 'claim'])
})

test('claim current machine key covers missing, unregistered, owned, and unowned registrations', async () => {
  const rootFor = () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-current-claim-'))
    roots.push(root)
    return { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
  }
  let calls = 0
  await claimCurrentMachineKey(
    {
      listMachineKeys: async () => {
        calls += 1
        return []
      },
    } as unknown as ConfigClient,
    rootFor(),
  )
  expect(calls).toBe(0)

  const pair = await generateMachineKeyPair()
  const keyId = await machineKeyId(pair.publicKey)
  const env = rootFor()
  writeMachineKey(pair, env)
  const listed = (userId: string | null) => ({
    keyId,
    publicKey: Buffer.from(pair.publicKey).toString('base64url'),
    label: 'fixture',
    createdAt: '2026-11-03T00:00:00.000Z',
    revokedAt: null,
    userId,
  })

  await claimCurrentMachineKey({ listMachineKeys: async () => [] } as unknown as ConfigClient, env)
  await claimCurrentMachineKey(
    { listMachineKeys: async () => [listed('user-a')] } as unknown as ConfigClient,
    env,
  )

  const spaceId = '01990000-0000-7000-8000-000000000021'
  const sender = await generateMachineKeyPair()
  const nonce = crypto.getRandomValues(new Uint8Array(KEY_SIZE))
  const claimCalls: string[] = []
  await claimCurrentMachineKey(
    {
      listMachineKeys: async () => [listed(null)],
      whoami: async () => ({ user: { id: 'user-a' }, activeSpaceId: spaceId }),
      createMachineKeyClaimChallenge: async (recipientKeyId: string) => {
        claimCalls.push('challenge')
        const sealed = await sealClaimChallenge({
          nonce,
          spaceId,
          keyId: recipientKeyId,
          senderPrivateKey: sender.privateKey,
          senderPublicKey: sender.publicKey,
          recipientPublicKey: pair.publicKey,
        })
        return {
          challengeId: 'claim-b',
          enc: Buffer.from(sealed.enc).toString('base64url'),
          ciphertext: Buffer.from(sealed.ciphertext).toString('base64url'),
          senderPublicKey: Buffer.from(sender.publicKey).toString('base64url'),
        }
      },
      claimMachineKey: async (_keyId: string, challengeId: string, opened: string) => {
        claimCalls.push('claim')
        expect(challengeId).toBe('claim-b')
        expect(new Uint8Array(Buffer.from(opened, 'base64url'))).toEqual(nonce)
        return { claimed: true as const }
      },
    } as unknown as ConfigClient,
    env,
  )
  expect(claimCalls).toEqual(['challenge', 'claim'])
})
