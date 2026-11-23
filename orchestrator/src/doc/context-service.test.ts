import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberHostedRecord } from '../record/install-binding-write.ts'
import { assertRecordContextItemRevision } from '../record/record-context-items.ts'
import { contextCursorWarning } from './context-cursor-warning-decision.ts'
import { listContextItems } from './context-item-store.ts'
import {
  clearTaskContext,
  cursorAncestorTasks,
  dropContextItem,
  dropSessionContextItemsForLifecycle,
  getContext,
  sessionContextItems,
  setContextItem,
} from './context-service.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from './context-write-adapter.ts'
import { ContextWriteRefusalError } from './doc-context-write.ts'
import { taskContextHolder } from './doc-subjects.ts'

const globals = globalThis as typeof globalThis & {
  [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts
}
const task = { key: 'DEV-2293', record_id: newRecordId(), project: PLATFORM_SLUG }

const contextReadMethods = (items: Awaited<ReturnType<typeof sessionContextItems>>) => ({
  listContextItems: async (holders: string[]) =>
    items.filter((item) => holders.includes(item.holder)),
  getContextItem: async (holder: string, slug: string) =>
    items.find((item) => item.holder === holder && item.id === slug) ?? null,
})

function installContextFacts(children: ContextFactsPorts['children'] = async () => []) {
  upsertProject({
    recordId: newRecordId(),
    name: PLATFORM_SLUG,
    path: process.cwd(),
    settings: { keyPrefixes: ['DEV'], space: 'personal' },
  })
  globals[CONTEXT_FACTS_PORTS_KEY] = {
    task: async () => task,
    lookup: async () => task,
    record: async () => task,
    children,
    pointer: async (value) =>
      value.startsWith('doc:') ? `doc-store record ${value} does not resolve` : null,
  }
}

test('task context set reuses the resolved children read', async () => {
  let childReads = 0
  installContextFacts(async () => {
    childReads++
    return []
  })

  await setContextItem({
    task: task.key,
    id: 'single-children-read',
    kind: 'fact',
    source: 'test',
    body: 'Resolved once.',
  })

  expect(childReads).toBe(1)
})

test('hosted task reads return record items when the local row is absent', async () => {
  installContextFacts()
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  const at = '2026-11-21T00:00:00.000Z'
  try {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const memory = createMemoryRecordApiClient({
      contextItems: [
        {
          recordId: newRecordId(),
          holder: `task:${task.record_id}`,
          id: 'probe',
          kind: 'fact',
          body: 'visible from the record',
          source: 'test',
          questionNumber: null,
          target: null,
          revision: at,
          createdAt: at,
          updatedAt: at,
        },
      ],
    })
    let readDestination: string | undefined
    installRecordApiClient({
      ...memory,
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'other-space',
        personalSpaceId: 'personal-space',
        memberships: [
          { space_id: 'other-space', slug: 'other', permission: 'write' },
          { space_id: 'project-space', slug: 'personal', permission: 'write' },
        ],
      }),
      listContextItems: async (holders, destination) => {
        readDestination = destination.destinationSpaceId
        return memory.listContextItems(holders, destination)
      },
    })
    expect(db().query('SELECT slug FROM context_item WHERE slug=?').get('probe')).toBeNull()
    expect((await getContext({ task: task.key })).items.map((item) => item.id)).toEqual(['probe'])
    expect(
      (await listContextItems(taskContextHolder(task.record_id), db())).map((item) => item.id),
    ).toEqual(['probe'])
    expect(readDestination).toBe('project-space')
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('a brief-shaped owned holder batch skips task reads and makes one context-item read', async () => {
  installContextFacts()
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  let listReads = 0
  let taskReads = 0
  let destinationResolutions = 0
  try {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const client = createMemoryRecordApiClient()
    globals[CONTEXT_FACTS_PORTS_KEY] = {
      ...globals[CONTEXT_FACTS_PORTS_KEY]!,
      record: async () => {
        taskReads++
        return task
      },
    }
    installRecordApiClient({
      ...client,
      whoami: async () => {
        destinationResolutions++
        return {
          user: { id: 'user-a' },
          activeSpaceId: 'other-space',
          personalSpaceId: 'personal-space',
          memberships: [
            { space_id: 'other-space', slug: 'other', permission: 'write' },
            { space_id: 'project-space', slug: 'personal', permission: 'write' },
          ],
        }
      },
      listContextItems: async (holders, destination) => {
        listReads++
        expect(destination.destinationSpaceId).toBe('project-space')
        return client.listContextItems(holders, destination)
      },
    })

    await listContextItems(
      [
        `session:batch-session`,
        {
          holder: taskContextHolder(task.record_id),
          owner: { kind: 'task', projectName: PLATFORM_SLUG },
        },
        {
          holder: taskContextHolder(newRecordId()),
          owner: { kind: 'task', projectName: PLATFORM_SLUG },
        },
      ],
      db(),
    )
    expect(taskReads).toBe(0)
    expect(destinationResolutions).toBe(2)
    expect(listReads).toBe(1)
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('hosted context set with no related holders skips the empty batch read', async () => {
  installContextFacts()
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  let listReads = 0
  try {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const client = createMemoryRecordApiClient()
    installRecordApiClient({
      ...client,
      listContextItems: async (holders, destination) => {
        listReads++
        return client.listContextItems(holders, destination)
      },
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [{ space_id: 'personal-space', slug: 'personal', permission: 'write' }],
      }),
      upsertContextItem: async () => ({
        id: newRecordId(),
        createdAt: '2026-11-21T00:00:00.000Z',
        updatedAt: '2026-11-21T00:00:00.000Z',
      }),
    })

    await expect(
      setContextItem({
        task: task.key,
        id: 'no-related-holders',
        kind: 'fact',
        source: 'test',
        body: 'The empty related-holder batch is a no-op.',
      }),
    ).resolves.toMatchObject({ id: 'no-related-holders' })
    expect(listReads).toBe(1)
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

afterEach(() => {
  delete globals[CONTEXT_FACTS_PORTS_KEY]
  installRecordApiClient(null)
})

test('cursor ancestry skips the target, caches shared ancestors, and carries grandchildren', async () => {
  const target = { key: 'DEV-1', project: PLATFORM_SLUG }
  let targetLookups = 0
  const direct = await cursorAncestorTasks({
    task: target,
    openCursors: [{ project: PLATFORM_SLUG, taskKey: target.key }],
    lookup: async () => {
      targetLookups++
      return null
    },
  })
  expect(targetLookups).toBe(0)
  expect(
    contextCursorWarning({
      task: target,
      openCursors: [{ project: PLATFORM_SLUG, taskKey: target.key }],
      tasks: direct,
    }),
  ).toBeNull()

  const rows = [
    { key: 'DEV-2', project: PLATFORM_SLUG, parent_key: 'DEV-4' },
    { key: 'DEV-3', project: PLATFORM_SLUG, parent_key: 'DEV-4' },
    { key: 'DEV-4', project: PLATFORM_SLUG, parent_key: target.key },
  ]
  const reads = new Map<string, number>()
  const openCursors = [
    { project: PLATFORM_SLUG, taskKey: 'DEV-2' },
    { project: PLATFORM_SLUG, taskKey: 'DEV-3' },
  ]
  const ancestors = await cursorAncestorTasks({
    task: target,
    openCursors,
    lookup: async (project, key) => {
      reads.set(key, (reads.get(key) ?? 0) + 1)
      return rows.find((row) => row.project === project && row.key === key) ?? null
    },
  })

  expect(reads.get('DEV-4')).toBe(1)
  expect(contextCursorWarning({ task: target, openCursors, tasks: ancestors })).toBeNull()
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
  await expect(write).rejects.toThrow('not visible in the document store')
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
        outcome: 'failed',
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

test('lifecycle task clear passes revisions and counts already-absent hosted rows', async () => {
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
  const hostedItems = await listContextItems(taskContextHolder(task.record_id), db())
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  const removals: { id: string; input: { expectedRevision?: string } }[] = []
  try {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const memory = createMemoryRecordApiClient()
    installRecordApiClient({
      ...memory,
      ...contextReadMethods(hostedItems),
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [{ space_id: 'personal-space', slug: 'personal', permission: 'write' }],
      }),
      deleteContextItem: async (id, input) => {
        removals.push({ id, input })
        if (removals.length === 1)
          db()
            .query(
              "UPDATE context_item SET updated_at='2026-11-13T19:41:54.000Z' WHERE holder_kind='task'",
            )
            .run()
        return { removed: removals.length === 1 }
      },
    })

    expect(await clearTaskContext({ task: task.key })).toEqual(
      expect.objectContaining({ removed: 1, alreadyAbsent: 1 }),
    )
    expect(removals).toHaveLength(2)
    expect(removals.map((removal) => removal.input)).toEqual(
      hostedItems.map((item) => ({ expectedRevision: item.revision })),
    )
    expect(
      db().query('SELECT 1 FROM context_item WHERE record_id=?').get(hostedItems[0]!.recordId),
    ).not.toBeNull()
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('lifecycle drop resolves its project from a session run when presence is absent', async () => {
  const session = newRecordId()
  const ownerProject = `session-owner-${session}`
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
    const projectRecordId = newRecordId()
    upsertProject({
      recordId: projectRecordId,
      name: ownerProject,
      path: `/tmp/${ownerProject}`,
      settings: { space: 'session-space' },
    })
    addRun({ agent: 'codex', job: 'implement', session, projectRecordId })
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const memory = createMemoryRecordApiClient()
    let removedFromSpace: string | undefined
    installRecordApiClient({
      ...memory,
      ...contextReadMethods([item]),
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [
          { space_id: 'personal-space', slug: 'personal', permission: 'write' },
          { space_id: 'session-space', slug: 'session-space', permission: 'write' },
        ],
      }),
      deleteContextItem: async (_id, _input, destination) => {
        removedFromSpace = destination.destinationSpaceId
        return { removed: false }
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
        outcome: 'already-absent',
        error: null,
      }),
    ])
    expect(removedFromSpace).toBe('session-space')
    expect(
      db().query('SELECT 1 FROM context_item WHERE record_id=?').get(item.recordId),
    ).not.toBeNull()
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('lifecycle drop reports a divergent hosted revision and leaves the local mirror untouched', async () => {
  const session = newRecordId()
  const ownerProject = `session-owner-${session}`
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    await setContextItem({
      session,
      id: 'divergent-revision',
      kind: 'fact',
      source: 'test',
      body: 'Drop this even when the hosted revision differs.',
    })
    const items = await sessionContextItems(session, db())
    const item = items[0]!
    const hostedRevision = '2026-11-16T00:00:00.000Z'
    expect(item.revision).not.toBe(hostedRevision)
    upsertProject({
      recordId: newRecordId(),
      name: ownerProject,
      path: `/tmp/${ownerProject}`,
      settings: { space: 'session-space' },
    })
    db()
      .query(
        `INSERT INTO presence(session_id,harness,role,machine,project,cwd,last_seen)
         VALUES (?,'codex','architect','test-machine',?,'/tmp/session-owner','2026-11-16T00:00:00.000Z')`,
      )
      .run(session, ownerProject)
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const memory = createMemoryRecordApiClient()
    installRecordApiClient({
      ...memory,
      ...contextReadMethods([item]),
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [
          { space_id: 'personal-space', slug: 'personal', permission: 'write' },
          { space_id: 'session-space', slug: 'session-space', permission: 'write' },
        ],
      }),
      deleteContextItem: async (_id, input) => {
        assertRecordContextItemRevision(input.expectedRevision, hostedRevision)
        return { removed: true }
      },
    })

    expect(
      await dropSessionContextItemsForLifecycle({
        session,
        reason: 'test divergent hosted revision',
        items,
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        error: expect.stringContaining('context item changed'),
      }),
    ])
    expect(
      db().query('SELECT 1 FROM context_item WHERE record_id=?').get(item.recordId),
    ).not.toBeNull()
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('lifecycle drop ignores a stale local mirror when deleting the hosted row', async () => {
  const session = newRecordId()
  const ownerProject = `session-owner-${session}`
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    await setContextItem({
      session,
      id: 'locally-changed',
      kind: 'fact',
      source: 'test',
      body: 'The lifecycle caller selected this fact.',
    })
    const items = await sessionContextItems(session, db())
    const selected = items[0]!
    db()
      .query(
        "UPDATE context_item SET kind='ruling',body='Keep the rewritten item.',source='q2377',question_number=2377,updated_at='2026-11-17T05:10:22.635Z' WHERE record_id=?",
      )
      .run(selected.recordId)
    expect((await sessionContextItems(session, db()))[0]!.revision).not.toBe(selected.revision)
    upsertProject({
      recordId: newRecordId(),
      name: ownerProject,
      path: `/tmp/${ownerProject}`,
      settings: { space: 'session-space' },
    })
    db()
      .query(
        `INSERT INTO presence(session_id,harness,role,machine,project,cwd,last_seen)
         VALUES (?,'codex','architect','test-machine',?,'/tmp/session-owner','2026-11-16T00:00:00.000Z')`,
      )
      .run(session, ownerProject)
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const memory = createMemoryRecordApiClient()
    let hostedDeleteCalled = false
    installRecordApiClient({
      ...memory,
      ...contextReadMethods([selected]),
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [
          { space_id: 'personal-space', slug: 'personal', permission: 'write' },
          { space_id: 'session-space', slug: 'session-space', permission: 'write' },
        ],
      }),
      deleteContextItem: async () => {
        hostedDeleteCalled = true
        return { removed: true }
      },
    })

    expect(
      await dropSessionContextItemsForLifecycle({
        session,
        reason: 'test local rewrite after selection',
        items,
      }),
    ).toEqual([expect.objectContaining({ outcome: 'dropped', error: null })])
    expect(hostedDeleteCalled).toBe(true)
    expect(
      db().query('SELECT kind FROM context_item WHERE record_id=?').get(selected.recordId),
    ).toEqual({ kind: 'ruling' })
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('lifecycle drop keeps the local item when the session owner cannot be resolved', async () => {
  const session = newRecordId()
  const priorSession = process.env.CLAUDE_CODE_SESSION_ID
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.CLAUDE_CODE_SESSION_ID = session
  try {
    await setContextItem({
      session,
      id: 'ownerless',
      kind: 'fact',
      source: 'test',
      body: 'Keep this until its hosted space can be established.',
    })
    const item = (await getContext({ session })).items[0]!
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      ...contextReadMethods([item]),
    })

    expect(
      await dropSessionContextItemsForLifecycle({
        session,
        reason: 'test missing owner',
        items: [item],
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        error: expect.stringContaining(`session ${session} has no recorded owning project`),
      }),
    ])
    expect((await getContext({ session })).items).toEqual([
      expect.objectContaining({ id: item.id }),
    ])
  } finally {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})

test('single-item drop leaves a local mirror alone when hosted row is absent', async () => {
  installContextFacts()
  await setContextItem({
    task: task.key,
    id: 'hosted-absent-single',
    kind: 'fact',
    source: 'test',
    body: 'Drop the local copy.',
  })
  const item = (await listContextItems(taskContextHolder(task.record_id), db()))[0]!
  const priorUrl = process.env.BOTTEGA_RECORD_API_URL
  try {
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
    rememberHostedRecord(db())
    const memory = createMemoryRecordApiClient()
    installRecordApiClient({
      ...memory,
      ...contextReadMethods([item]),
      whoami: async () => ({
        user: { id: 'user-a' },
        activeSpaceId: 'personal-space',
        personalSpaceId: 'personal-space',
        memberships: [{ space_id: 'personal-space', slug: 'personal', permission: 'write' }],
      }),
      deleteContextItem: async () => ({ removed: false }),
    })

    expect(await dropContextItem({ task: task.key, id: 'hosted-absent-single' })).toEqual(
      expect.objectContaining({ removed: false, alreadyAbsent: true }),
    )
    expect(
      db().query('SELECT 1 FROM context_item WHERE record_id=?').get(item.recordId),
    ).not.toBeNull()
  } finally {
    if (priorUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorUrl
  }
})
