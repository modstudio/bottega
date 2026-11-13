import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberHostedRecord } from '../record/install-binding-write.ts'
import { recordApiError } from '../record/record-api-client-error.ts'
import {
  clearTaskContext,
  dropContextItem,
  dropSessionContextItemsForLifecycle,
  getContext,
  setContextItem,
} from './context-service.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from './context-write-adapter.ts'
import { ContextWriteRefusalError } from './doc-context-write.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}
const task = { key: 'DEV-2293', record_id: newRecordId(), project: PLATFORM_SLUG }

function installContextFacts() {
  upsertProject({
    recordId: newRecordId(),
    name: PLATFORM_SLUG,
    path: '/tmp/context-item-test',
    settings: { keyPrefixes: ['DEV'] },
  })
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    tasks: async () => [task],
    task: async () => task,
    pointer: async (value) =>
      value.startsWith('doc:') ? `doc-store record ${value} does not resolve` : null,
  }
}

afterEach(() => {
  delete globals[CONTEXT_FACTS_PORTS_KEY]
  installRecordApiClient(null)
})

test('context service stores structured columns and compare-and-set revisions', async () => {
  installContextFacts()
  const first = await setContextItem({
    task: task.key,
    id: 'decision',
    kind: 'position',
    source: 'q6056',
    body: 'Keep the approved shape.',
  })
  expect(first).toEqual(
    expect.objectContaining({ id: 'decision', kind: 'position', source: 'q6056' }),
  )
  expect((await getContext({ task: task.key })).items).toEqual([
    expect.objectContaining({
      id: 'decision',
      questionNumber: 6056,
      target: null,
    }),
  ])
  await expect(
    dropContextItem({ task: task.key, id: 'decision', expectedRevision: 'stale' }),
  ).rejects.toThrow('expected revision stale')
  expect(
    await dropContextItem({
      task: task.key,
      id: 'decision',
      expectedRevision: first.revision,
    }),
  ).toEqual(expect.objectContaining({ removed: true }))
})

test('a pointer to a nonexistent document UUID is refused before write', async () => {
  installContextFacts()
  const write = setContextItem({
    task: task.key,
    id: 'missing-doc',
    kind: 'pointer',
    source: 'test',
    body: `doc:${newRecordId()}`,
  })
  // A refusal, not a retryable failure: context moments suppress their retry hint on this class.
  await expect(write).rejects.toBeInstanceOf(ContextWriteRefusalError)
  await expect(write).rejects.toThrow('does not resolve')
  expect((await getContext({ task: task.key })).items).toEqual([])
})

test('whole-holder clear removes every context item', async () => {
  installContextFacts()
  await setContextItem({
    task: task.key,
    id: 'position',
    kind: 'position',
    source: 'test',
    body: 'Continue.',
  })
  await setContextItem({
    task: task.key,
    id: 'fact',
    kind: 'fact',
    source: 'test',
    body: 'Measured.',
  })
  expect(await clearTaskContext({ task: task.key })).toEqual(
    expect.objectContaining({ removed: 2 }),
  )
  expect((await getContext({ task: task.key })).items).toEqual([])
})

test('worker environments refuse every context-item write entry point', async () => {
  const priorDepth = process.env.BOTTEGA_DEPTH
  const priorRunId = process.env.BOTTEGA_RUN_ID
  process.env.BOTTEGA_DEPTH = '1'
  delete process.env.BOTTEGA_RUN_ID
  try {
    await expect(
      setContextItem({ task: task.key, id: 'fact', kind: 'fact', source: 'test', body: 'No.' }),
    ).rejects.toThrow('setContextItem')
    await expect(dropContextItem({ task: task.key, id: 'fact' })).rejects.toThrow('dropContextItem')
    await expect(clearTaskContext({ task: task.key })).rejects.toThrow('clearTaskContext')
    expect(
      await dropSessionContextItemsForLifecycle({
        session: 'worker-session',
        reason: 'test',
        items: [
          {
            holder: 'session:worker-session',
            id: 'fact',
            recordId: newRecordId(),
            kind: 'fact',
            body: 'No.',
            source: 'test',
            questionNumber: null,
            target: null,
            revision: '2026-11-13T00:00:00.000Z',
            createdAt: '2026-11-13T00:00:00.000Z',
            updatedAt: '2026-11-13T00:00:00.000Z',
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        removed: false,
        error: expect.stringContaining('dropSessionContextItemForLifecycle'),
      }),
    ])
  } finally {
    if (priorDepth === undefined) delete process.env.BOTTEGA_DEPTH
    else process.env.BOTTEGA_DEPTH = priorDepth
    if (priorRunId === undefined) delete process.env.BOTTEGA_RUN_ID
    else process.env.BOTTEGA_RUN_ID = priorRunId
  }
})

test('lifecycle drop reports an absent hosted row and keeps the local item', async () => {
  const session = newRecordId()
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    await setContextItem({
      session,
      id: 'hosted-absent',
      kind: 'fact',
      source: 'test',
      body: 'Keep this locally when the hosted row is absent.',
    })
    const item = (await getContext({ session })).items[0]!
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const memory = createMemoryRecordApiClient()
    installRecordApiClient({
      ...memory,
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [{ space_id: 'personal-space', slug: 'personal', permission: 'write' }],
      }),
      // The delete route answers an absent row with this 404, which the transport throws.
      deleteContextItem: async (id) => {
        throw recordApiError({ error: `context item ${id} not found` }, 404)
      },
    })

    expect(
      await dropSessionContextItemsForLifecycle({
        session,
        reason: 'test absent hosted row',
        items: [item],
      }),
    ).toEqual([
      expect.objectContaining({
        removed: false,
        error: expect.stringContaining(`context item ${item.recordId} not found`),
      }),
    ])
    expect((await getContext({ session })).items).toEqual([
      expect.objectContaining({ id: 'hosted-absent' }),
    ])
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})
