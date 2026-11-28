import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { upsertProject } from '../project/projects.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import { readDoc, readDocs, readDocsForWrite } from './doc-authoritative-read.ts'
import { docCommand } from './doc-commands.ts'
import { removeReadDoc } from './doc-removal-service.ts'
import { resolveDocWriteSpace } from './doc-write-space.ts'
import { consumeDoc, setDoc, setDocStatus } from './docs.ts'

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
  let reads = 0
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
    listDocs: async (query, destination) => {
      reads++
      return {
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
      }
    },
    deleteDoc: async (id, _input, destination) => {
      deletes.push({ id, destination: destination.destinationSpaceId })
      rows = rows.filter((row) => row.id !== id)
      return { id, revisionId: newRecordId() }
    },
  } satisfies RecordApiClient)
  return { deletes, reads: () => reads, rows: () => rows }
}

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

function removeCommand(scope: string, slug: string, subject?: string, space?: string) {
  const args = ['doc', 'rm', slug, '--scope', scope, '--reason', 'test removal']
  const values = new Map([
    ['scope', scope],
    ['reason', 'test removal'],
    ...(subject ? ([['subject', subject]] as const) : []),
    ...(space ? ([['space', space]] as const) : []),
  ])
  return docCommand(
    'rm',
    args,
    { has: (name) => values.has(name), flag: (name) => values.get(name) },
    {
      log: () => undefined,
      error: () => undefined,
      write: () => undefined,
      stdinText: async () => '',
      stdinIsTTY: false,
      cwd: () => process.cwd(),
    },
    {
      selectDocWriteTree: () => undefined,
      collectCanonLintInput: undefined as never,
      consumeResumeHandoff: undefined as never,
      revisionHistory: async () => null,
    },
  )
}

test('unscoped list, scoped global list, show, and remove agree across readable spaces', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const remote = hostedRow('team-space', 'Team docs')
  const fixture = installHostedRows([remote])

  expect((await readDocs()).map(({ slug }) => slug)).toContain('remote-global')
  expect((await readDocs({ scope: 'global' })).map(({ slug }) => slug)).toContain('remote-global')
  expect((await readDoc('global', undefined, 'remote-global'))?.record_id).toBe(remote.id)
  await removeCommand('global', 'remote-global')
  expect(fixture.deletes).toEqual([{ id: remote.id, destination: 'team-space' }])
  expect(fixture.rows()).toEqual([])
})

test('removeReadDoc deletes a hosted row in the space where it was read', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const remote = hostedRow('team-space', 'Team docs')
  const fixture = installHostedRows([remote])
  const target = (await readDocsForWrite({ scope: 'global' })).find(
    ({ doc }) => doc?.slug === 'remote-global',
  )

  expect(target).toEqual(expect.objectContaining({ spaceId: 'team-space' }))
  expect(
    await removeReadDoc(target!, { reason: 'remove the row from the space where it was read' }),
  ).toBe(true)
  expect(fixture.deletes).toEqual([{ id: remote.id, destination: 'team-space' }])
  expect(fixture.rows()).toEqual([])
})

test('readDocsForWrite excludes an owned twin when owner is absent', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  upsertProject({
    recordId: newRecordId(),
    name: PLATFORM_SLUG,
    path: process.cwd(),
    settings: { space: 'Team docs' },
  })
  const unowned = {
    ...hostedRow('team-space', 'Team docs'),
    scope: 'project',
    subject: PLATFORM_SLUG,
    slug: 'reference-twin',
    form: 'reference',
    parent_slug: 'cli',
  }
  const owned = {
    ...unowned,
    id: newRecordId(),
    owner: 'another-user',
    latestRevisionId: newRecordId(),
  }
  installHostedRows([unowned, owned])

  const targets = await readDocsForWrite({ scope: 'project', subject: PLATFORM_SLUG })

  expect(targets.map(({ doc }) => doc?.record_id)).toEqual([unowned.id])
})

test('remove refuses a cross-space miss with the address, search extent, and remedy', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installHostedRows([])

  await expect(removeCommand('global', 'missing-global')).rejects.toThrow(
    `no global/_ doc "missing-global" in every readable space; use ${PLATFORM_SLUG} doc list --scope global to see what exists`,
  )
})

test('the rm command refuses a hosted miss after one authoritative read', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const fixture = installHostedRows([])
  await expect(removeCommand('global', 'missing-global')).rejects.toThrow(
    'no global/_ doc "missing-global" in every readable space',
  )
  expect(fixture.reads()).toBe(1)
})

test('remove refuses the same global address in two spaces and names both', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installHostedRows([hostedRow('personal-space', 'Personal'), hostedRow('team-space', 'Team docs')])

  await expect(removeCommand('global', 'remote-global')).rejects.toThrow(
    'several global docs "remote-global" match spaces: Personal, Team docs; retry with --space Personal or --space Team docs',
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
  ).rejects.toThrow('retry with --space Personal or --space Team docs')
  await expect(
    setDocStatus('global', undefined, 'remote-global', 'archived', null, {
      reason: 'exercise status ambiguity refusal',
    }),
  ).rejects.toThrow('retry with --space Personal or --space Team docs')
  await expect(
    consumeDoc('global', undefined, 'remote-global', {
      reason: 'exercise consume ambiguity refusal',
    }),
  ).rejects.toThrow('retry with --space Personal or --space Team docs')
})

test('a named space selects one duplicate and an unknown slug names the space list', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const personal = hostedRow('personal-space', 'Personal')
  const team = hostedRow('team-space', 'Team docs')
  const fixture = installHostedRows([personal, team])

  const selected = await resolveDocWriteSpace('doc rm', 'Team docs')
  expect(selected).toEqual({ spaceId: 'team-space', slug: 'Team docs' })
  await removeCommand('global', 'remote-global', undefined, 'Team docs')
  expect(fixture.deletes).toEqual([{ id: team.id, destination: 'team-space' }])

  await expect(resolveDocWriteSpace('doc rm', 'mistyped')).rejects.toThrow(
    `${PLATFORM_SLUG} record space list`,
  )
})

test('a subject-taking write requires a subject while the same read still finds the row', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const row = {
    ...hostedRow('team-space', 'Team docs'),
    scope: 'project',
    subject: PLATFORM_SLUG,
  }
  installHostedRows([row])

  expect((await readDoc('project', undefined, 'remote-global'))?.subject).toBe(PLATFORM_SLUG)
  await expect(removeCommand('project', 'remote-global')).rejects.toThrow(
    'project document writes require --subject',
  )
})

test('an existing hosted write refuses when its read row names no space', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const row = hostedRow('team-space', 'Team docs')
  delete (row as Partial<HostedRow>).spaceId
  installHostedRows([row])

  await expect(
    setDoc({
      scope: 'global',
      subject: undefined,
      slug: 'remote-global',
      title: 'No destination',
      body: 'This write must not fall back to the active space.',
      reason: 'exercise missing target guard',
    }),
  ).rejects.toThrow('the read target names no space')
})
