import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConfigClient } from '../../../shared/config-client.ts'
import { readHostedConfigIdentity } from '../../../shared/hosted-config-space.ts'
import { readMachineKey } from '../../../shared/machine-key-store.ts'
import { readTrustList } from '../../../shared/trust-list.ts'
import { deleteEntry, machineInit, planRotation, setEntry } from './config-service.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
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
