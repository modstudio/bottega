import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import { readDoc, readDocs } from './doc-authoritative-read.ts'
import { consumeDoc, removeDoc, setDoc, setDocStatus } from './docs.ts'

type HostedRow = Record<string, unknown> & { id: string; spaceId: string }

const hostedRow = (spaceId: string, spaceName: string): HostedRow => ({
  id: newRecordId(),
  spaceId,
  spaceName,
  scope: 'global',
  subject: null,
  owner: null,
  slug: 'remote-global',
  title: 'Remote global',
  body: 'Hosted outside the active space.',
  delivery: 'demand',
  audiences: ['technical'],
  status: 'current',
  kind: 'working',
  position: 0,
  featured: false,
  latestRevisionId: newRecordId(),
  createdAt: '2026-11-27T00:00:00.000Z',
  updatedAt: '2026-11-27T00:00:00.000Z',
})

function installHostedRows(initial: HostedRow[]) {
  let rows = [...initial]
  const deletes: Array<{ id: string; destination: string }> = []
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'personal-space',
      personalSpaceId: 'personal-space',
      memberships: [
        { space_id: 'personal-space', slug: 'Personal', permission: 'write' },
        { space_id: 'team-space', slug: 'Team docs', permission: 'write' },
      ],
    }),
    listDocs: async (query, destination) => ({
      items: rows
        .filter((row) => query.scope === undefined || row.scope === query.scope)
        .filter((row) => query.subject === undefined || row.subject === query.subject)
        .filter((row) => query.slug === undefined || row.slug === query.slug)
        .filter(
          (row) =>
            query.acrossReadableSpaces ||
            destination?.destinationSpaceId === undefined ||
            row.spaceId === destination.destinationSpaceId,
        )
        .slice(0, query.limit),
      nextCursor: null,
    }),
    deleteDoc: async (id, _input, destination) => {
      deletes.push({ id, destination: destination.destinationSpaceId })
      rows = rows.filter((row) => row.id !== id)
      return { id, revisionId: newRecordId() }
    },
  } satisfies RecordApiClient)
  return { deletes, rows: () => rows }
}

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('unscoped list, scoped global list, show, and remove agree across readable spaces', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const remote = hostedRow('team-space', 'Team docs')
  const fixture = installHostedRows([remote])

  expect((await readDocs()).map(({ slug }) => slug)).toContain('remote-global')
  expect((await readDocs({ scope: 'global' })).map(({ slug }) => slug)).toContain('remote-global')
  expect((await readDoc('global', undefined, 'remote-global'))?.record_id).toBe(remote.id)
  expect(
    await removeDoc('global', undefined, 'remote-global', { reason: 'remove agreement fixture' }),
  ).toBe(true)
  expect(fixture.deletes).toEqual([{ id: remote.id, destination: 'team-space' }])
  expect(fixture.rows()).toEqual([])
})

test('remove refuses a cross-space miss with the address, search extent, and remedy', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installHostedRows([])

  await expect(
    removeDoc('global', undefined, 'missing-global', { reason: 'exercise missing refusal' }),
  ).rejects.toThrow(
    'no global/_ doc "missing-global" in every readable space; use bottega doc list --scope global to see what exists',
  )
})

test('remove refuses the same global address in two spaces and names both', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installHostedRows([hostedRow('personal-space', 'Personal'), hostedRow('team-space', 'Team docs')])

  await expect(
    removeDoc('global', undefined, 'remote-global', { reason: 'exercise ambiguity refusal' }),
  ).rejects.toThrow(
    'several global docs "remote-global" match spaces: Personal, Team docs; pass --subject to select one',
  )
  await expect(
    setDoc({
      scope: 'global',
      subject: undefined,
      slug: 'remote-global',
      title: 'Ambiguous update',
      body: 'Do not write this.',
      reason: 'exercise set ambiguity refusal',
    }),
  ).rejects.toThrow('match spaces: Personal, Team docs; pass --subject')
  await expect(
    setDocStatus('global', undefined, 'remote-global', 'archived', null, {
      reason: 'exercise status ambiguity refusal',
    }),
  ).rejects.toThrow('match spaces: Personal, Team docs; pass --subject')
  await expect(
    consumeDoc('global', undefined, 'remote-global', {
      reason: 'exercise consume ambiguity refusal',
    }),
  ).rejects.toThrow('match spaces: Personal, Team docs; pass --subject')
})
