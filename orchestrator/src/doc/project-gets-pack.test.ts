import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { listDocs } from '../../test/fixtures/doc-local-read.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  installRecordSessionRunner,
  memoryRecordSession,
} from '../../test/fixtures/record-session.ts'
import { retireProject, upsertProject } from '../project/projects.ts'
import { rememberHostedRecord } from '../record/install-binding-write.ts'
import { setDoc, signedInDocOwner } from './docs.ts'
import { projectGetsPack } from './project-gets-pack.ts'

describe('projectGetsPack', () => {
  test.each([
    ['retired project', '2026-09-15T00:00:00.000Z', 'project-space', true, false],
    ['hosted live project with a space', null, 'project-space', true, true],
    ['hosted live project without a space', null, null, true, false],
    ['local live project without a space', null, null, false, true],
  ] as const)('%s', (_label, retiredAt, declaredSpace, hostedRead, expected) => {
    expect(projectGetsPack({ retiredAt, declaredSpace, hostedRead })).toBe(expected)
  })
})

test('owned canon can share a project canon slug while global canon still collides', async () => {
  const owner = '01990000-0000-7000-8000-000000000094'
  const slug = '.agents/rules/shared-owner-path.md'
  const body = '---\ndescription: Shared owner path\n---\n\nKeep this rule current.\n'
  const collectCanonLintInput = () => ({
    files: [],
    codexProjectDoc: true,
    trackedPaths: [],
    packageScripts: [],
    sourceTexts: [],
  })
  upsertProject({
    name: 'shared-owner-project',
    path: process.cwd(),
    canon: true,
    recordId: newRecordId(),
    stack: null,
    settings: {},
  })
  await setDoc({
    scope: 'canon',
    subject: 'shared-owner-project',
    slug,
    title: 'Project shared path',
    body,
    reason: 'seed project canon at the owned path',
    allowCanonBootstrap: true,
    collectCanonLintInput,
  })

  const owned = await setDoc({
    scope: 'canon',
    subject: null,
    owner,
    slug,
    title: 'User shared path',
    body,
    reason: 'store user canon at the project path',
    allowCanonBootstrap: true,
    collectCanonLintInput,
  })

  expect(listDocs({ scope: 'canon', subject: null, owner })).toContainEqual(owned)
  await expect(
    setDoc({
      scope: 'canon',
      subject: null,
      slug,
      title: 'Global shared path',
      body,
      reason: 'prove global canon still collides',
      collectCanonLintInput,
    }),
  ).rejects.toThrow('refusing canon path collision')
})

describe('hosted canon pack measurement', () => {
  const userId = '01990000-0000-7000-8000-000000000001'
  const personalSpaceId = '01990000-0000-7000-8000-000000000002'
  const projectSpaceId = '01990000-0000-7000-8000-000000000003'
  let priorRecordApiUrl: string | undefined

  beforeEach(() => {
    priorRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.BOTTEGA_RECORD_API_URL = 'https://record-api.example.test'
    const session = memoryRecordSession()
    session.setToken('fixture-session')
    installRecordSessionRunner(session.runner)
  })

  afterEach(() => {
    installRecordSessionRunner(null)
    if (priorRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorRecordApiUrl
  })

  function installHostedProjects(): Array<string | null | undefined> {
    upsertProject({
      name: 'retired-space-less',
      path: '/w/retired-space-less',
      canon: true,
      recordId: newRecordId(),
      stack: null,
      settings: {},
    })
    expect(retireProject('retired-space-less')).toBe('retired')
    upsertProject({
      name: 'live-with-space',
      path: '/w/live-with-space',
      canon: true,
      recordId: newRecordId(),
      stack: null,
      settings: { space: 'live-space' },
    })
    rememberHostedRecord()

    const reads: Array<string | null | undefined> = []
    const memory = createMemoryRecordApiClient()
    installRecordApiClient({
      ...memory,
      whoami: async () => ({
        user: { id: userId, name: 'Fixture', email: 'fixture@example.test' },
        activeSpaceId: personalSpaceId,
        personalSpaceId,
        memberships: [
          {
            space_id: projectSpaceId,
            name: 'Live space',
            slug: 'live-space',
            role: 'owner',
            permission: 'write',
          },
        ],
      }),
      listDocs: async (query, destination) => {
        reads.push(query.subject)
        return memory.listDocs(query, destination)
      },
    })

    return reads
  }

  test('a global canon write measures live projects with spaces and skips retired projects', async () => {
    const reads = installHostedProjects()

    const written = await setDoc({
      scope: 'canon',
      subject: null,
      slug: '.agents/rules/global-pack.md',
      title: 'Global pack',
      body: '---\ndescription: Global pack\n---\n\nGlobal rule.\n',
      reason: 'prove hosted global canon pack targets',
      allowCanonBootstrap: true,
    })

    expect(written.owner).toBeNull()
    expect(reads).not.toContain('retired-space-less')
    expect(reads).toContain('live-with-space')
  })

  test('a user canon write makes no project pack reads', async () => {
    const reads = installHostedProjects()

    const written = await setDoc({
      scope: 'canon',
      subject: null,
      owner: await signedInDocOwner(),
      slug: '.agents/rules/user-pack.md',
      title: 'User pack',
      body: '---\ndescription: User pack\n---\n\nUser rule.\n',
      reason: 'prove hosted user canon pack targets',
      allowCanonBootstrap: true,
    })

    expect(written.owner).toBe(userId)
    expect(reads).not.toContain('retired-space-less')
    expect(reads).not.toContain('live-with-space')
  })
})
