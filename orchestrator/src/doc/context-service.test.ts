import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { upsertProject } from '../project/projects.ts'
import {
  clearTaskContext,
  dropContextItem,
  dropSessionContextItemsForLifecycle,
  getContext,
  setContextItem,
} from './context-service.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from './context-write-adapter.ts'

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
  await expect(
    setContextItem({
      task: task.key,
      id: 'missing-doc',
      kind: 'pointer',
      source: 'test',
      body: `doc:${newRecordId()}`,
    }),
  ).rejects.toThrow('does not resolve')
  expect((await getContext({ task: task.key })).items).toEqual([])
})

test('whole-holder clear removes every context item', async () => {
  installContextFacts()
  await setContextItem({
    task: task.key,
    id: 'next',
    kind: 'next-action',
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
    await expect(dropContextItem({ task: task.key, id: 'fact' })).rejects.toThrow(
      'dropContextItem',
    )
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
