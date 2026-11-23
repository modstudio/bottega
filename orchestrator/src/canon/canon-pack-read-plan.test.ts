import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { cloneRepository } from '../../../shared/test-git-repository.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { hostedStoredDoc } from '../../test/fixtures/record-api-docs.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { compilePack } from './canon.ts'
import { storedRepositoryCanonRows } from './canon-stored-rows.ts'

const PACK_COMPILE_READ_PLAN_MAX_SEQUENTIAL_DEPTH = 2
const PACK_COMPILE_READ_PLAN_RESPONSE_BYTE_CAP = 2_048
const PACK_COMPILE_DOC_READS = 5
const PACK_COMPILE_PROJECT_READ_DEPTH = 1

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('pack compile keeps its hosted read plan within call-depth and response-byte budgets', async () => {
  const project = 'pack-read-plan'
  const cwd = cloneRepository(process.env, 'canon-pack-read-plan-')
  const personalSpaceId = newRecordId()
  const projectSpaceId = newRecordId()
  const userId = newRecordId()
  const identity = {
    user: { id: userId },
    activeSpaceId: projectSpaceId,
    personalSpaceId,
    memberships: [
      { space_id: personalSpaceId, slug: 'personal', permission: 'write' },
      { space_id: projectSpaceId, slug: 'team', permission: 'write' },
    ],
  }
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: cwd,
    settings: { trunk: 'main', space: 'team' },
  })
  rememberProjectSpace(db(), project, projectSpaceId)
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'

  let completedDepth = 0
  let responseBytes = 0
  let docReads = 0
  const depths: number[] = []
  const docReadDepths = new Map<string, number[]>()
  const pending: Array<() => void> = []
  let pendingIdentity: Promise<typeof identity> | undefined
  const contextFrontmatter = [
    '---',
    'description: Use the fixture context for guarded paths.',
    'paths:',
    '  - guarded/**',
    '---',
  ].join('\n')
  const fullContextBody = `${contextFrontmatter}\n${'large context body '.repeat(300)}`
  const client = createMemoryRecordApiClient()
  installRecordApiClient({
    ...client,
    whoami: () => {
      if (pendingIdentity) return pendingIdentity
      const depth = completedDepth + 1
      depths.push(depth)
      responseBytes += Buffer.byteLength(JSON.stringify(identity))
      pendingIdentity = new Promise((resolve) => {
        setTimeout(() => {
          completedDepth = Math.max(completedDepth, depth)
          pendingIdentity = undefined
          resolve(identity)
        }, 0)
      })
      return pendingIdentity
    },
    listDocs: (query) => {
      docReads += 1
      const depth = completedDepth + 1
      depths.push(depth)
      const address = `${query.scope ?? '*'}/${query.subject ?? '_'}`
      docReadDepths.set(address, [...(docReadDepths.get(address) ?? []), depth])
      const contextRows =
        query.scope === 'canon' && query.subject === project
          ? [
              {
                ...hostedStoredDoc({
                  id: newRecordId(),
                  scope: 'canon',
                  subject: project,
                  owner: null,
                  slug: '.agents/contexts/guarded.md',
                  title: 'Guarded context',
                  body: query.frontmatterOnly?.includes('.agents/contexts/')
                    ? contextFrontmatter
                    : fullContextBody,
                  delivery: 'demand',
                  status: 'current',
                  kind: 'working',
                  projectName: project,
                  createdAt: '2026-11-23T00:00:00.000Z',
                  updatedAt: '2026-11-23T00:00:00.000Z',
                  deletedAt: null,
                  latestRevisionId: newRecordId(),
                }),
                bodyTrimmed: query.frontmatterOnly?.includes('.agents/contexts/') === true,
              },
            ]
          : []
      const page = {
        items: contextRows.length
          ? contextRows
          : query.scope !== 'canon' && query.delivery !== 'inject'
            ? [
                hostedStoredDoc({
                  id: newRecordId(),
                  scope: query.scope ?? 'global',
                  subject: query.subject ?? null,
                  owner: null,
                  slug: 'unfiltered-demand-row',
                  title: 'Unfiltered demand row',
                  body: 'x'.repeat(PACK_COMPILE_READ_PLAN_RESPONSE_BYTE_CAP),
                  delivery: 'demand',
                  status: 'current',
                  kind: 'working',
                  projectName: null,
                  createdAt: '2026-11-23T00:00:00.000Z',
                  updatedAt: '2026-11-23T00:00:00.000Z',
                  deletedAt: null,
                  latestRevisionId: newRecordId(),
                }),
              ]
            : [],
        nextCursor: null,
      }
      responseBytes += Buffer.byteLength(JSON.stringify(page))
      return new Promise<typeof page>((resolve) => {
        pending.push(() => {
          completedDepth = Math.max(completedDepth, depth)
          resolve(page)
        })
        if (pending.length === 1) {
          setTimeout(() => {
            for (const finish of pending.splice(0)) finish()
          }, 0)
        }
      })
    },
  })

  const pack = await compilePack({ job: 'understand', cwd })
  expect(pack.markdown).toContain(
    '- `.agents/contexts/guarded.md` — Use the fixture context for guarded paths. — `guarded/**`',
  )
  expect(Math.max(...depths)).toBe(PACK_COMPILE_READ_PLAN_MAX_SEQUENTIAL_DEPTH)
  expect(docReadDepths.get(`canon/${project}`)).toEqual([PACK_COMPILE_PROJECT_READ_DEPTH])
  expect(docReadDepths.get(`project/${project}`)).toEqual([PACK_COMPILE_PROJECT_READ_DEPTH])
  expect(docReadDepths.get('canon/_')).toEqual([PACK_COMPILE_READ_PLAN_MAX_SEQUENTIAL_DEPTH])
  expect(docReadDepths.get('global/_')).toEqual([PACK_COMPILE_READ_PLAN_MAX_SEQUENTIAL_DEPTH])
  expect(docReadDepths.get('job/understand')).toEqual([PACK_COMPILE_READ_PLAN_MAX_SEQUENTIAL_DEPTH])
  expect(docReads).toBe(PACK_COMPILE_DOC_READS)
  expect(responseBytes).toBeLessThanOrEqual(PACK_COMPILE_READ_PLAN_RESPONSE_BYTE_CAP)

  const stored = await storedRepositoryCanonRows(project)
  expect(stored.find(({ slug }) => slug === '.agents/contexts/guarded.md')?.body).toBe(
    fullContextBody,
  )
})
