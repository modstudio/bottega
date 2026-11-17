import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberHostedRecord } from '../record/install-binding-write.ts'
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
    settings: { keyPrefixes: ['DEV'], space: 'personal' },
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
    expect.objectContaining({
      id: 'decision',
      kind: 'position',
      source: 'q6056',
      warning: expect.stringContaining(
        `${PLATFORM_SLUG} workflow compose <workflow> --project '${PLATFORM_SLUG}' --arg 'key=${task.key}'`,
      ),
    }),
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
    expect.objectContaining({ removed: 2, alreadyAbsent: 0 }),
  )
  expect((await getContext({ task: task.key })).items).toEqual([])
})

test('cursor context accepts its owning session and refuses a foreign session', async () => {
  installContextFacts()
  const owner = 'cursor-owner-session'
  const recordId = newRecordId()
  const projectRecordId = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(PLATFORM_SLUG)!.record_id
  db()
    .query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
        session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,
        state,closed,total_steps,created_at,updated_at,enforcement)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,?, 'ship-task','default','',
               ?,?,?,?,'{}',0,'plan','running','[]',1,?,?, 'floors')`,
    )
    .run(
      recordId,
      PLATFORM_SLUG,
      projectRecordId,
      recordId,
      owner,
      workflowVersionRecordId(db()),
      catalogueVersionRecordId(db()),
      '2026-11-14T10:00:00Z',
      '2026-11-14T10:00:00Z',
    )
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    process.env.CLAUDE_CODE_SESSION_ID = owner
    await expect(
      setContextItem({
        cursor: recordId,
        id: 'decision',
        kind: 'position',
        source: 'q42',
        body: 'Continue.',
      }),
    ).resolves.toEqual(
      expect.objectContaining({ holder: expect.stringContaining(recordId), warning: null }),
    )

    process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'
    await expect(
      setContextItem({
        cursor: recordId,
        id: 'foreign',
        kind: 'position',
        source: 'q43',
        body: 'Do not write this.',
      }),
    ).rejects.toThrow(
      `cursor ${recordId} belongs to another session; write from its owning session, or on the task`,
    )
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
})

test('session context includes open keyless cursor items and omits done cursors', async () => {
  installContextFacts()
  const session = newRecordId()
  const projectRecordId = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(PLATFORM_SLUG)!.record_id
  const insertCursor = (recordId: string, workflow: string) => {
    db()
      .query(
        `INSERT INTO workflow_cursor
         (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
          session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,
          state,closed,total_steps,created_at,updated_at,enforcement)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),?,?,?,'default','',
                 ?,?,?,?,'{}',0,'question','running','[]',1,?,?, 'floors')`,
      )
      .run(
        recordId,
        PLATFORM_SLUG,
        projectRecordId,
        workflow,
        recordId,
        session,
        workflowVersionRecordId(db()),
        catalogueVersionRecordId(db()),
        '2026-11-14T10:00:00Z',
        '2026-11-14T10:00:00Z',
      )
  }
  const openRecordId = newRecordId()
  const doneRecordId = newRecordId()
  insertCursor(openRecordId, 'explore')
  insertCursor(doneRecordId, 'plan-task')
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    process.env.CLAUDE_CODE_SESSION_ID = session
    await setContextItem({
      cursor: openRecordId,
      id: 'open-position',
      kind: 'position',
      source: 'q51',
      body: 'Keep the open cursor.',
    })
    await setContextItem({
      cursor: doneRecordId,
      id: 'done-position',
      kind: 'position',
      source: 'q52',
      body: 'Hide the done cursor.',
    })
    db().query("UPDATE workflow_cursor SET state='done' WHERE record_id=?").run(doneRecordId)

    expect((await getContext({ session })).cursorHolders).toEqual([
      {
        cursor: expect.any(Number),
        project: PLATFORM_SLUG,
        workflow: 'explore',
        mode: 'default',
        holder: expect.stringContaining(openRecordId),
        items: [expect.objectContaining({ id: 'open-position', body: 'Keep the open cursor.' })],
      },
    ])
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  }
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

test('lifecycle task clear ignores revisions and counts already-absent hosted rows', async () => {
  installContextFacts()
  await setContextItem({
    task: task.key,
    id: 'hosted-present',
    kind: 'fact',
    source: 'test',
    body: 'Remove from both stores.',
  })
  await setContextItem({
    task: task.key,
    id: 'hosted-absent',
    kind: 'fact',
    source: 'test',
    body: 'Remove only from the local store.',
  })
  db()
    .query("UPDATE context_item SET updated_at='2026-11-13T19:41:53.826Z' WHERE holder_kind='task'")
    .run()
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  const removals: { id: string; input: { expectedRevision?: string } }[] = []
  try {
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
      deleteContextItem: async (id, input) => {
        removals.push({ id, input })
        return { removed: removals.length === 1 }
      },
    })

    expect(await clearTaskContext({ task: task.key })).toEqual(
      expect.objectContaining({ removed: 1, alreadyAbsent: 1 }),
    )
    expect(removals).toHaveLength(2)
    expect(removals.map((removal) => removal.input)).toEqual([{}, {}])
    expect((await getContext({ task: task.key })).items).toEqual([])
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('lifecycle drop reports an absent hosted row and drops the local item', async () => {
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
      body: 'Drop this locally when the hosted row is absent.',
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
      deleteContextItem: async () => ({ removed: false }),
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
        alreadyAbsent: true,
        error: null,
      }),
    ])
    expect((await getContext({ session })).items).toEqual([])
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})
