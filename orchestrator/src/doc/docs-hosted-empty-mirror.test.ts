import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { compilePack } from '../canon/canon.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { projectAt, upsertProject } from '../project/projects.ts'
import type { RecordApiClient, RecordDocUpsertInput } from '../record/record-api-client.ts'
import type { RecordDocRevision } from '../record/record-doc-mapping.ts'
import { readDocRevision, readDocs } from './doc-authoritative-read.ts'
import { removeDoc } from './doc-removal-service.ts'
import { setDocFromCommand } from './doc-set-source-files.ts'
import {
  consumeDoc,
  importDocs,
  readOpenResumes,
  restoreDoc,
  setDoc,
  setDocStatus,
} from './docs.ts'
import { commitDocSet } from './local-doc-write.ts'

const docId = '01990000-0000-7000-8000-000000000101'
const revisionId = '01990000-0000-7000-8000-000000000102'
const restoredRevisionId = '01990000-0000-7000-8000-000000000103'

const hostedRow = (overrides: Record<string, unknown> = {}) => ({
  id: docId,
  spaceId: 'personal-space',
  spaceName: 'personal-space',
  scope: 'global',
  subject: null,
  owner: null,
  slug: 'hosted-only',
  title: 'Hosted only',
  body: 'Hosted body.',
  delivery: 'demand',
  audiences: ['technical'],
  status: 'current',
  kind: 'working',
  position: 0,
  featured: false,
  latestRevisionId: revisionId,
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
  ...overrides,
})

function hostedClient(overrides: Partial<RecordApiClient> = {}): RecordApiClient {
  const client = createMemoryRecordApiClient()
  return {
    ...client,
    listDocs: async () => ({ items: [hostedRow()], nextCursor: null }),
    ...overrides,
  }
}

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('pack compile batches five hosted inject reads and uses row revision ids', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const project = `hosted-pack-${newRecordId()}`
  const path = process.cwd()
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path,
    settings: { space: 'personal-space' },
  })
  const queries: Array<Record<string, unknown>> = []
  let active = 0
  let peak = 0
  installRecordApiClient(
    hostedClient({
      whoami: async () => ({
        user: { id: 'user-a', name: 'Fixture', email: 'fixture@example.test' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [
          {
            space_id: 'personal-space',
            slug: 'personal-space',
            permission: 'write',
            role: 'owner',
          },
        ],
      }),
      listDocs: async (query) => {
        queries.push(query)
        active += 1
        peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        const row =
          query.scope === 'job'
            ? hostedRow({
                id: newRecordId(),
                scope: 'job',
                subject: 'understand',
                slug: 'hosted-inject',
                title: 'Hosted inject',
                body: 'Hosted inject body.',
                delivery: 'inject',
              })
            : query.scope === 'canon' && query.subject === null
              ? hostedRow({
                  id: newRecordId(),
                  scope: 'canon',
                  subject: null,
                  owner: 'user-a',
                  slug: 'owned-canon.md',
                  title: 'Owned canon',
                  body: 'OWNED-CANON-MUST-NOT-BE-GLOBAL',
                  delivery: 'inject',
                })
              : null
        return { items: row ? [row] : [], nextCursor: null }
      },
    }),
  )

  const pack = await compilePack({ job: 'understand', cwd: path })
  expect(pack.docs).toEqual([expect.objectContaining({ slug: 'hosted-inject', revisionId })])
  expect(queries).toHaveLength(5)
  expect(queries.filter((query) => query.delivery === 'inject')).toHaveLength(3)
  expect(peak).toBe(5)
  expect(pack.markdown).not.toContain('OWNED-CANON-MUST-NOT-BE-GLOBAL')
})

test('pack compile refuses with a hosted-read remedy when the record is unreachable', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient(
    hostedClient({
      listDocs: async () => {
        throw new Error('fixture record unavailable')
      },
    }),
  )
  await expect(compilePack({ job: 'understand', cwd: '/tmp/no-project' })).rejects.toThrow(
    /hosted documents could not be read: fixture record unavailable.*record whoami/s,
  )
})

test('hosted revision and resume count work with an empty mirror', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const project = `hosted-resume-${newRecordId()}`
  const path = process.cwd()
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path,
    settings: { space: 'personal-space' },
  })
  const revision: RecordDocRevision = {
    id: revisionId,
    docId,
    scope: 'resume',
    subject: project,
    owner: null,
    slug: 'brief',
    op: 'create',
    title: 'Brief',
    body: `---\nstatus: open\nepic: DEV-1\nproject: ${project}\nwritten: 2026-11-22T00:00:00.000Z\n---\n\nNEXT ACTION: continue.\n`,
    withheldForAudience: false,
    delivery: 'demand',
    audiences: ['technical'] as ['technical'],
    parentId: null,
    position: 0,
    status: 'current',
    kind: 'working',
    author: 'fixture',
    authorName: null,
    reason: 'fixture',
    sessionId: null,
    at: '2026-11-22T00:00:00.000Z',
  }
  installRecordApiClient(
    hostedClient({
      whoami: async () => ({
        user: { id: 'user-a', name: 'Fixture', email: 'fixture@example.test' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [
          {
            space_id: 'personal-space',
            slug: 'personal-space',
            permission: 'write',
            role: 'owner',
          },
        ],
      }),
      listDocs: async (query) => ({
        items:
          query.scope === 'resume'
            ? [hostedRow({ ...revision, id: docId, latestRevisionId: revisionId })]
            : [],
        nextCursor: null,
      }),
      getDocRevision: async () => revision,
    }),
  )

  expect((await readDocRevision(revisionId))?.record_id).toBe(revisionId)
  expect(await readDocs({ scope: 'resume', subject: project })).toHaveLength(1)
  expect(projectAt(path)?.name).toBe(project)
  expect((await readOpenResumes(path)).open).toHaveLength(1)
})

test('doc set updates the hosted row when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const requests: RecordDocUpsertInput[] = []
  installRecordApiClient(
    hostedClient({
      upsertDoc: async (input) => {
        requests.push(input)
        return {
          id: docId,
          revisionId: restoredRevisionId,
          form: input.form,
          articleSubject: null,
          relatedSubjects: [],
          sourceFiles: input.sourceFiles,
          checkedAgainstCommit: input.checkedAgainstCommit,
          summary: input.summary,
        }
      },
    }),
  )

  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'hosted-only',
    title: 'Updated',
    body: 'Updated body.',
    delivery: 'demand',
    reason: 'update hosted-only fixture',
  })

  expect(requests[0]).toEqual(
    expect.objectContaining({ id: docId, expectedRevision: revisionId, op: 'set' }),
  )
})

test('doc set pack budget includes hosted docs when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const project = `hosted-write-budget-${newRecordId()}`
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: process.cwd(),
    settings: { space: 'personal-space' },
  })
  const queries: Array<Record<string, unknown>> = []
  installRecordApiClient(
    hostedClient({
      whoami: async () => ({
        user: { id: 'user-a', name: 'Fixture', email: 'fixture@example.test' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [
          {
            space_id: 'personal-space',
            slug: 'personal-space',
            permission: 'write',
            role: 'owner',
          },
        ],
      }),
      listDocs: async (query) => {
        queries.push(query)
        return {
          items:
            query.scope === 'job' && query.subject === 'file-question' && !query.slug
              ? [
                  hostedRow({
                    scope: 'job',
                    subject: 'file-question',
                    slug: 'hosted-pack-base',
                    title: 'Hosted pack base',
                    body: 'Hosted content. '.repeat(200),
                    delivery: 'inject',
                  }),
                ]
              : [],
          nextCursor: null,
        }
      },
    }),
  )
  const ceiling = JOBS['file-question']!.packBytes
  JOBS['file-question']!.packBytes = 1_000
  try {
    await expect(
      setDoc({
        scope: 'job',
        subject: 'file-question',
        slug: 'proposed',
        title: 'Proposed',
        body: 'Small proposed content.',
        delivery: 'inject',
        reason: 'test hosted pack budget',
      }),
    ).rejects.toThrow(
      new RegExp(`canon pack file-question/${project} would be \\d+ bytes; ceiling is 1000 bytes`),
    )
    expect(queries.filter((query) => query.status === 'current')).toHaveLength(5)
  } finally {
    JOBS['file-question']!.packBytes = ceiling
  }
})

test('doc status updates the hosted row when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const requests: RecordDocUpsertInput[] = []
  installRecordApiClient(
    hostedClient({
      upsertDoc: async (input) => {
        requests.push(input)
        return {
          id: docId,
          revisionId: restoredRevisionId,
          form: input.form,
          articleSubject: null,
          relatedSubjects: [],
          sourceFiles: input.sourceFiles,
          checkedAgainstCommit: input.checkedAgainstCommit,
          summary: input.summary,
        }
      },
    }),
  )

  await setDocStatus('global', null, 'hosted-only', 'archived', null, {
    reason: 'archive hosted-only fixture',
  })
  expect(requests[0]).toEqual(
    expect.objectContaining({ status: 'archived', expectedRevision: revisionId }),
  )
})

test('doc rm deletes the hosted row when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const deletes: Array<{ id: string; expectedRevision?: string }> = []
  installRecordApiClient(
    hostedClient({
      deleteDoc: async (id, input) => {
        deletes.push({ id, expectedRevision: input.expectedRevision })
        return { id, revisionId: restoredRevisionId }
      },
    }),
  )

  expect(await removeDoc('global', null, 'hosted-only', { reason: 'remove hosted fixture' })).toBe(
    true,
  )
  expect(deletes).toContainEqual({ id: docId, expectedRevision: revisionId })
})

test('consume reaches the hosted resume when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  upsertProject({
    recordId: newRecordId(),
    name: 'fixture',
    path: '/tmp/fixture',
    settings: { space: 'personal-space' },
  })
  const body = [
    '---',
    'status: open',
    'epic: DEV-1',
    'project: fixture',
    'written: 2026-11-22T00:00:00.000Z',
    '---',
    '',
    'NEXT ACTION: continue.',
  ].join('\n')
  const consumes: Array<{ id: string; expectedRevision?: string }> = []
  installRecordApiClient(
    hostedClient({
      whoami: async () => ({
        user: { id: 'user-a', name: 'Fixture', email: 'fixture@example.test' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [
          { space_id: 'personal-space', slug: 'personal', permission: 'write', role: 'owner' },
        ],
      }),
      listDocs: async () => ({
        items: [hostedRow({ scope: 'resume', subject: 'fixture', body })],
        nextCursor: null,
      }),
      consumeDoc: async (id, input) => {
        consumes.push({ id, expectedRevision: input.expectedRevision })
        return { id, revisionId: restoredRevisionId, alreadyConsumed: false }
      },
    }),
  )

  await consumeDoc('resume', 'fixture', 'hosted-only', { reason: 'consume hosted fixture' })
  expect(consumes).toContainEqual({ id: docId, expectedRevision: revisionId })
})

test('hosted restore mirrors after the local revision becomes stale', async () => {
  const staleLocalRevision = newRecordId()
  commitDocSet({
    scope: 'global',
    subject: null,
    owner: null,
    slug: 'hosted-only',
    projectId: null,
    title: 'Stale local title',
    body: 'Stale local body.',
    delivery: 'demand',
    audiences: ['technical'],
    parentId: null,
    position: 0,
    identity: { author: 'fixture', reason: 'seed stale local mirror', session: null },
    recordId: docId,
    revisionId: staleLocalRevision,
  })
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const revision: RecordDocRevision = {
    id: restoredRevisionId,
    docId,
    scope: 'global',
    subject: null,
    owner: null,
    slug: 'hosted-only',
    op: 'set',
    title: 'Earlier title',
    body: 'Earlier body.',
    withheldForAudience: false,
    delivery: 'demand',
    audiences: ['technical'],
    parentId: null,
    position: 0,
    featured: false,
    status: 'current',
    kind: 'working',
    form: null,
    articleSubject: null,
    relatedSubjects: [],
    sourceFiles: [],
    checkedAgainstCommit: null,
    summary: null,
    replacementSlug: null,
    author: 'fixture',
    authorName: null,
    reason: 'fixture revision',
    sessionId: null,
    at: '2026-11-21T00:00:00.000Z',
  }
  const client = hostedClient() as RecordApiClient & {
    getDocRevision(id: string): Promise<typeof revision>
  }
  client.getDocRevision = async (id) => {
    expect(id).toBe(restoredRevisionId)
    return revision
  }
  client.restoreDoc = async (id, input) => {
    expect(id).toBe(docId)
    expect(input.revisionId).toBe(restoredRevisionId)
    expect(input.expectedRevision).toBe(revisionId)
    return { id, revisionId: newRecordId() }
  }
  installRecordApiClient(client)

  await restoreDoc('global', null, 'hosted-only', restoredRevisionId, {
    reason: 'restore hosted revision',
    expectedRevision: revisionId,
  })
  expect(
    db().query<{ body: string }, [string]>('SELECT body FROM doc WHERE record_id=?').get(docId)
      ?.body,
  ).toBe('Earlier body.')
})

test('doc import uses the hosted revision when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const root = mkdtempSync(join(tmpdir(), 'hosted-doc-import-'))
  const requests: RecordDocUpsertInput[] = []
  try {
    mkdirSync(join(root, 'global', '_'), { recursive: true })
    writeFileSync(
      join(root, 'global', '_', 'hosted-only.md'),
      '---\ntitle: "Imported"\n---\n\nImported body.\n',
    )
    installRecordApiClient(
      hostedClient({
        upsertDoc: async (input) => {
          requests.push(input)
          return { id: docId, revisionId: restoredRevisionId }
        },
      }),
    )

    expect((await importDocs(root, { reason: 'import hosted fixture' })).count).toBe(1)
    expect(requests[0]?.expectedRevision).toBe(revisionId)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doc set --source merges hosted source files when the local mirror is empty', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const project = `hosted-source-${newRecordId()}`
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: `/tmp/${project}`,
    settings: { space: 'personal' },
  })
  const requests: RecordDocUpsertInput[] = []
  installRecordApiClient(
    hostedClient({
      whoami: async () => ({
        user: { id: 'user-a', name: 'Fixture', email: 'fixture@example.test' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [
          { space_id: 'personal-space', slug: 'personal', permission: 'write', role: 'owner' },
        ],
      }),
      listDocs: async () => ({
        items: [
          hostedRow({
            scope: 'project',
            subject: project,
            kind: 'article',
            form: 'overview',
            sourceFiles: ['docs/existing.md'],
          }),
        ],
        nextCursor: null,
      }),
      upsertDoc: async (input) => {
        requests.push(input)
        return {
          id: docId,
          revisionId: restoredRevisionId,
          form: input.form,
          articleSubject: null,
          relatedSubjects: [],
          sourceFiles: input.sourceFiles,
          checkedAgainstCommit: input.checkedAgainstCommit,
          summary: input.summary,
        }
      },
    }),
  )

  await setDocFromCommand(
    {
      scope: 'project',
      subject: project,
      slug: 'hosted-only',
      title: 'Hosted only',
      body: 'Hosted body.',
      delivery: 'demand',
      audiences: ['technical'],
      kind: 'article',
      form: 'overview',
      reason: 'merge hosted source files',
    },
    { given: ['docs/new.md'], replace: false },
  )
  expect(requests[0]).toEqual(
    expect.objectContaining({
      expectedRevision: revisionId,
      sourceFiles: ['docs/existing.md', 'docs/new.md'],
    }),
  )
})
