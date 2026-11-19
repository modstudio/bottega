import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type ConfigClient,
  ConfigClientError,
  type ConfigEntry,
} from '../../../shared/config-client.ts'
import { ConfigEntrySchema, MachineConfigFileEntrySchema } from '../../../shared/config-contract.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { writeHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { getConfigEntry, listEntries, setConfigEntry } from '../config/config-service.ts'
import { verifyConfigWrite } from '../config/config-write-verification.ts'
import { secretWriteTarget } from '../config/secret-write-target.ts'
import {
  assertConfigWriteAllowed,
  configListPresentation,
  configReadDestination,
  configReadPresentation,
  configSetPresentation,
  configWriteTarget,
} from './config.ts'

const row = {
  key: 'autonomy.stage.review',
  environment: 'default',
  scope: 'user' as const,
  value: 'review',
  rowVersion: 3,
  updatedAt: '2026-09-25T12:00:00.000Z',
}

const operatorPid = 400
const operatorInventory = {
  ascertainable: true as const,
  rows: [
    {
      pid: operatorPid,
      ppid: 1,
      pgid: operatorPid,
      command: `${PLATFORM_SLUG} machine config set`,
    },
  ],
}

test('config list --json presents the structured rows', () => {
  expect(JSON.parse(configListPresentation([row], true)[0]!)).toEqual([row])
})

test('config set JSON for hosted and machine homes parses with the hub consumer contracts', async () => {
  const destinations: Array<{ destinationSpaceId: string }> = []
  const client = {
    whoami: async () => ({ personalSpaceId: 'space-personal', memberships: [] }),
    putEntry: async (
      _key: string,
      _input: unknown,
      destination: { destinationSpaceId: string },
    ) => {
      destinations.push(destination)
      return { ...row, rowVersion: 4 }
    },
  } as unknown as ConfigClient
  const hosted = await setConfigEntry('autonomy.stage.review', 'review', 'user', null, client)
  expect(destinations).toEqual([{ destinationSpaceId: 'space-personal' }])
  expect(ConfigEntrySchema.parse(JSON.parse(configSetPresentation(hosted)))).toEqual({
    ...row,
    rowVersion: 4,
  })

  const root = mkdtempSync(join(tmpdir(), 'config-set-presentation-'))
  try {
    const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
    const machine = await setConfigEntry('hub.port', '9000', 'machine', undefined, undefined, env)
    expect(MachineConfigFileEntrySchema.parse(JSON.parse(configSetPresentation(machine)))).toEqual({
      key: 'hub.port',
      value: '9000',
      scope: 'machine',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('config get presents the local autonomy value that outranks a hosted row', () => {
  expect(
    configReadPresentation(
      {
        key: 'autonomy.preset',
        value: 'manual',
        home: 'user',
        source: 'hosted user scope',
        ignoredHostedScopes: [],
        outrankingMachineValue: 'autonomous',
      },
      false,
    ),
  ).toEqual([
    'manual',
    'source: hosted user scope',
    'machine.toml value outranks it at the local user scope: autonomous',
  ])
})

test('an orchestrator worker run cannot write autonomy while an operator process can', () => {
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', { BOTTEGA_RUN_ID: '6731' }),
  ).toThrow(
    `refusing operator-only machine config write from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine config set autonomy.ship-to production`,
  )
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', {}, operatorPid, operatorInventory),
  ).not.toThrow()
})

test('a descendant of an orchestrator run executor cannot write autonomy after unsetting its run id', () => {
  const inventory = {
    ascertainable: true as const,
    rows: [
      { pid: 100, ppid: 1, pgid: 100, command: 'bun orchestrator/src/run/exec.ts 6731 prompt job' },
      { pid: 200, ppid: 100, pgid: 100, command: 'codex worker' },
      {
        pid: 300,
        ppid: 200,
        pgid: 100,
        command: `${PLATFORM_SLUG} machine config set autonomy.release promote`,
      },
    ],
  }
  expect(() => assertConfigWriteAllowed('autonomy.release', 'promote', {}, 300, inventory)).toThrow(
    'refusing operator-only machine config write from an orchestrator worker run',
  )
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'promote', {}, 400, inventory),
  ).not.toThrow()
})

test('an orchestrator worker run cannot change machine delegation', () => {
  expect(() =>
    assertConfigWriteAllowed('delegation.implement', 'harness', { BOTTEGA_RUN_ID: '6731' }),
  ).toThrow(
    `refusing operator-only machine config write from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine config set --machine delegation.implement harness`,
  )
  expect(() =>
    assertConfigWriteAllowed('delegation.review', undefined, { BOTTEGA_RUN_ID: '6731' }),
  ).toThrow(
    `refusing operator-only machine config write from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine config delete --machine delegation.review`,
  )
})

test('an explicit invalid ship-to write is refused with the shared allowed list', () => {
  expect(() =>
    assertConfigWriteAllowed('autonomy.release', 'automatic', {}, operatorPid, operatorInventory),
  ).toThrow('expected one of branch, trunk, production')
})

test('config writes route user scope to personal space and named scope independently of active space', async () => {
  const client = {
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'active-space',
      personalSpaceId: 'personal-space',
      memberships: [
        { space_id: 'active-space', slug: 'active', permission: 'write' },
        { space_id: 'personal-space', slug: 'personal', permission: 'write' },
        { space_id: 'named-space', slug: 'named', permission: 'write' },
      ],
    }),
  } as unknown as ConfigClient

  await expect(configWriteTarget('machine config set', undefined, client)).resolves.toEqual({
    scope: 'user',
    destination: { destinationSpaceId: 'personal-space' },
  })
  await expect(configWriteTarget('machine config set', 'named', client)).resolves.toEqual({
    scope: 'space',
    destination: { destinationSpaceId: 'named-space' },
    spaceSlug: 'named',
  })
  await expect(configWriteTarget('machine config set', 'missing', client)).rejects.toThrow(
    'not a member of record space missing',
  )
})

test('named-space config reads route to the same destination as the write', async () => {
  const rows = new Map<string, ConfigEntry>()
  const destinationId = (destination: { destinationSpaceId?: string }) =>
    destination.destinationSpaceId ?? 'active-space'
  const storedAt = (key: string, scope: string, destination: { destinationSpaceId?: string }) =>
    `${destinationId(destination)}:${scope}:${key}`
  const client = {
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'active-space',
      personalSpaceId: 'personal-space',
      memberships: [
        { space_id: 'active-space', slug: 'active', permission: 'write' },
        { space_id: 'personal-space', slug: 'personal', permission: 'write' },
        { space_id: 'other-space', slug: 'other', permission: 'write' },
      ],
    }),
    getEntry: async (
      key: string,
      scope: string,
      _environment: string,
      destination: { destinationSpaceId?: string } = {},
    ) => {
      const stored = rows.get(storedAt(key, scope, destination))
      if (!stored) throw new ConfigClientError('response', `/v1/config/entries/${key}`, 404)
      return stored
    },
    putEntry: async (
      key: string,
      input: { scope: 'user' | 'space'; environment: string; value: string },
      destination: { destinationSpaceId: string },
    ) => {
      const stored = {
        key,
        environment: input.environment,
        scope: input.scope,
        value: input.value,
        rowVersion: 1,
        updatedAt: '2026-11-18T12:00:00.000Z',
      }
      rows.set(storedAt(key, input.scope, destination), stored)
      return stored
    },
    listEntries: async (_environment: string, destination: { destinationSpaceId?: string } = {}) =>
      [...rows.entries()]
        .filter(([location]) => location.startsWith(`${destinationId(destination)}:`))
        .map(([, stored]) => stored),
  } as unknown as ConfigClient

  const target = await configWriteTarget('machine config set', 'other', client)
  const written = await setConfigEntry(
    'autonomy.stage.review',
    'review',
    target.scope,
    undefined,
    client,
    process.env,
    () => client,
    target.destination,
  )
  if (!('environment' in written.row)) throw new Error('expected a hosted row')
  await verifyConfigWrite(
    client,
    written.row,
    target.destination,
    `${PLATFORM_SLUG} machine config set autonomy.stage.review review --space other`,
  )

  const named = await configReadDestination('machine config get', 'other', client)
  await expect(
    getConfigEntry('autonomy.stage.review', 'space', client, process.env, () => client, named),
  ).resolves.toMatchObject({ value: 'review', home: 'space' })
  await expect(
    getConfigEntry('autonomy.stage.review', undefined, client, process.env, () => client),
  ).rejects.toThrow()
  await expect(
    getConfigEntry(
      'autonomy.stage.review',
      'space',
      client,
      process.env,
      () => client,
      await configReadDestination('machine config get', true, client),
    ),
  ).rejects.toThrow()

  expect(await listEntries(client, named)).toEqual([written.row])
  expect(
    await listEntries(client, await configReadDestination('machine config list', true, client)),
  ).toEqual([])
  expect(await listEntries(client)).toEqual([])
})

test('an unflagged secret write uses the machine pinned space instead of personal space', async () => {
  const root = mkdtempSync(join(tmpdir(), 'secret-write-target-'))
  try {
    const pinnedSpaceId = '01990000-0000-7000-8000-000000000011'
    const userId = '01990000-0000-7000-8000-000000000012'
    const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
    writeHostedConfigIdentity({ spaceId: pinnedSpaceId, userId }, env)
    const client = {
      whoami: async () => ({
        user: { id: userId },
        activeSpaceId: pinnedSpaceId,
        personalSpaceId: '01990000-0000-7000-8000-000000000099',
        memberships: [],
      }),
    } as unknown as ConfigClient

    await expect(secretWriteTarget(undefined, client, env)).resolves.toEqual({
      scope: 'user',
      destination: { destinationSpaceId: pinnedSpaceId },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a config write without a personal space names the record sign-in remedy', async () => {
  const client = {
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: null,
      personalSpaceId: null,
      memberships: [],
    }),
  } as unknown as ConfigClient

  await expect(configWriteTarget('machine config set', undefined, client)).rejects.toThrow(
    `${PLATFORM_SLUG} record sign-in`,
  )
})
