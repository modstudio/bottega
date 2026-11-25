import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import '../../test/fixtures/record-authority.ts'
import { decideFloorSatisfaction } from './workflow-floor.ts'
import {
  CURSOR_RECORD_ID,
  database,
  gather,
  identity,
  insertRun,
  projectId,
  unlinkedIdentity,
} from './workflow-floor-evidence.fixture.ts'
import { hubTaskReadFromJson } from './workflow-floor-task-read.ts'

test('a bare number still refuses a run bound to another cursor', async () => {
  const d = database()
  const runId = insertRun(d, {
    project: 'fixture',
    launchKey: 'DEV-1',
    branch: 'DEV-1-work',
  })
  const number = d
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(runId)!.number

  await expect(gather(d, { artifacts: [String(number)] })).rejects.toThrow(
    `--artifact ${number} task reference is task-DEV-1, not this cursor's DEV-977`,
  )
})

test('a task document on the cursor task is stable recorded evidence', async () => {
  const d = database()
  const readTaskDocument = async (value: string) => ({
    id: 'document-id',
    label: value,
    task_record_id: 'task-DEV-977',
    updated_at: '2026-09-02',
  })

  expect(
    (await gather(d, { artifacts: ['DEV-977/1'] }, { readTaskDocument })).artifacts?.[0]?.artifact,
  ).toEqual({ ref: 'DEV-977/1', exists: true })
})

test('a task document on another task is refused before it is read', async () => {
  const readTaskDocument = async () => {
    throw new Error('another task must not be read')
  }

  await expect(
    gather(database(), { artifacts: ['DEV-1/1'] }, { readTaskDocument }, unlinkedIdentity),
  ).rejects.toThrow("--artifact DEV-1/1 task is not this cursor's DEV-977")
})

test("a task document follows the cursor's task record when its key changes", async () => {
  const readTaskDocument = async (value: string) => ({
    id: 'document-id',
    label: value,
    task_record_id: 'task-DEV-977',
    updated_at: '2026-09-02',
  })

  expect(
    (await gather(database(), { artifacts: ['DEV-1/1'] }, { readTaskDocument })).artifacts?.[0]
      ?.artifact,
  ).toEqual({ ref: 'DEV-1/1', exists: true })
})

test('a task document on another task record is refused', async () => {
  const readTaskDocument = async (value: string) => ({
    id: 'document-id',
    label: value,
    task_record_id: 'task-DEV-1',
    updated_at: '2026-09-02',
  })

  await expect(
    gather(database(), { artifacts: ['DEV-1/1'] }, { readTaskDocument }),
  ).rejects.toThrow("--artifact DEV-1/1 task is not this cursor's DEV-977")
})

test('a missing task document refusal names its form and cursor task', async () => {
  const readTaskDocument = async () => null

  await expect(
    gather(database(), { artifacts: ['DEV-977/2'] }, { readTaskDocument }),
  ).rejects.toThrow("--artifact DEV-977/2 does not exist for this cursor's task DEV-977")
})

test('doc UUID evidence still resolves only through the doc store', async () => {
  const d = database()
  const id = newRecordId()
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
     VALUES ('project','fixture','unchanged','t','b','inject','["technical"]','t','t',?,?)`,
  ).run(projectId(d, 'fixture'), id)

  expect((await gather(d, { artifacts: [`doc:${id}`] })).artifacts?.[0]?.artifact).toEqual({
    ref: 'doc:project/fixture/unchanged',
    exists: true,
  })
})

test('a doc must change during the active step', async () => {
  const d = database()
  const id = newRecordId()
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
     VALUES ('project','fixture','freshness','t','b','inject','["technical"]','2026-08-01','2026-08-01',?,?)`,
  ).run(projectId(d, 'fixture'), id)

  await expect(gather(d, { artifacts: [`doc:${id}`] })).rejects.toThrow(
    'doc record time is 2026-08-01, before step activation 2026-09-01',
  )
  d.query('UPDATE doc SET updated_at=? WHERE record_id=?').run('2026-09-02', id)
  await expect(gather(d, { artifacts: [`doc:${id}`] })).resolves.toBeDefined()
})

test('tasks must change during the active step when their tracker reports an update time', async () => {
  const d = database()
  const readTask = (updatedAt: string | null) => () => ({
    recordId: 'task-DEV-977',
    key: 'DEV-977',
    updatedAt,
    status: 'done',
    statusCategory: 'done',
    commentIds: [],
    commentsVerifiable: true,
  })

  await expect(
    gather(d, { artifacts: ['task:DEV-977'] }, { readTask: readTask('2026-08-01') }),
  ).rejects.toThrow(
    'task record time is 2026-08-01, before step activation 2026-09-01; write or change the task record during this step, then cite it',
  )
  await expect(
    gather(d, { artifacts: ['task:DEV-977'] }, { readTask: readTask('2026-08-01') }),
  ).rejects.not.toThrow('--task')

  await expect(
    gather(d, { artifacts: ['task:DEV-977'] }, { readTask: readTask('2026-08-01') }, identity, [
      {
        kind: 'tracker-transition',
        deferrable: false,
        expectedExitCode: 0,
        expectedStatus: 'active',
        requirePullRequest: false,
        operatorRuling: false,
      },
    ]),
  ).rejects.toThrow(
    'task record time is 2026-08-01, before step activation 2026-09-01; make the tracker transition and pass `--task DEV-977`',
  )
  await expect(
    gather(d, { artifacts: ['task:DEV-977'] }, { readTask: readTask('2026-08-01') }, identity, [
      {
        kind: 'tracker-transition',
        deferrable: false,
        expectedExitCode: 0,
        expectedStatus: 'active',
        requirePullRequest: false,
        operatorRuling: false,
      },
    ]),
  ).rejects.not.toThrow('needs no write')
  await expect(
    gather(d, { artifacts: ['task:DEV-977'] }, { readTask: readTask('2026-09-02') }),
  ).resolves.toBeDefined()

  const untimed = await gather(d, { artifacts: ['task:DEV-977'] }, { readTask: readTask(null) })
  expect(
    decideFloorSatisfaction({
      floors: [
        {
          kind: 'recorded-artifact',
          deferrable: false,
          expectedExitCode: 0,
          expectedStatus: 'done',
          requirePullRequest: false,
          operatorRuling: false,
        },
      ],
      evidence: untimed,
      enforcement: 'floors',
      finishing: false,
      openObligations: [],
    }),
  ).toMatchObject({
    action: 'allow',
    notices: ['freshness unchecked: the tracker returns no task update time'],
  })
})

test('a fresh tracker task without its own update time reports freshness unchecked', async () => {
  const d = database()
  const trackerRead = hubTaskReadFromJson('DEV-977', {
    task: {
      record_id: 'task-DEV-977',
      key: 'DEV-977',
      updated_at: '2026-09-02',
      status: 'done',
      status_category: 'done',
    },
    tracker_updated_at: null,
    tracker_comment_ids: [],
    tracker_comments_verifiable: true,
  })

  const evidence = await gather(d, { artifacts: ['task:DEV-977'] }, { readTask: () => trackerRead })
  expect(evidence.artifacts?.[0]?.artifact).toEqual({
    ref: 'task:DEV-977',
    exists: true,
    notice: 'freshness unchecked: the tracker returns no task update time',
  })
})

test('task comments and documents must change during the active step', async () => {
  const d = database()
  const readTask = (writtenAt: string) => () => ({
    recordId: 'task-DEV-977',
    key: 'DEV-977',
    updatedAt: '2026-09-02',
    status: 'done',
    statusCategory: 'done',
    commentIds: ['4'],
    commentWrittenAt: { '4': writtenAt },
    commentsVerifiable: true,
  })
  await expect(
    gather(d, { artifacts: ['task:DEV-977#comment:4'] }, { readTask: readTask('2026-08-01') }),
  ).rejects.toThrow('task comment record time is 2026-08-01')
  await expect(
    gather(d, { artifacts: ['task:DEV-977#comment:4'] }, { readTask: readTask('2026-09-02') }),
  ).resolves.toBeDefined()
  const untimed = await gather(
    d,
    { artifacts: ['task:DEV-977#comment:4'] },
    {
      readTask: () => ({
        ...readTask('2026-09-02')(),
        commentWrittenAt: {},
      }),
    },
  )
  expect(
    decideFloorSatisfaction({
      floors: [
        {
          kind: 'recorded-artifact',
          deferrable: false,
          expectedExitCode: 0,
          expectedStatus: 'done',
          requirePullRequest: false,
          operatorRuling: false,
        },
      ],
      evidence: untimed,
      enforcement: 'floors',
      finishing: false,
      openObligations: [],
    }),
  ).toMatchObject({
    action: 'allow',
    notices: ['freshness unchecked: external tracker returns no comment time'],
  })

  const readTaskDocument = (updatedAt: string) => async (value: string) => ({
    id: 'document-id',
    label: value,
    task_record_id: 'task-DEV-977',
    updated_at: updatedAt,
  })
  await expect(
    gather(d, { artifacts: ['DEV-977/1'] }, { readTaskDocument: readTaskDocument('2026-08-01') }),
  ).rejects.toThrow('task document record time is 2026-08-01')
  await expect(
    gather(d, { artifacts: ['DEV-977/1'] }, { readTaskDocument: readTaskDocument('2026-09-02') }),
  ).resolves.toBeDefined()
})

test('notes and attached text must be written during the active step', async () => {
  const d = database()
  const noteId = newRecordId()
  const readNote = (writtenAt: string) => async () => ({
    recordId: noteId,
    label: 'fixture#1',
    promotedTask: null,
    staleAt: null,
    writtenAt,
  })
  await expect(
    gather(d, { artifacts: [`note:${noteId}`] }, { readNote: readNote('2026-08-01') }),
  ).rejects.toThrow('note record time is 2026-08-01')
  await expect(
    gather(d, { artifacts: [`note:${noteId}`] }, { readNote: readNote('2026-09-02') }),
  ).resolves.toBeDefined()

  let promotedNoteReads = 0
  const gathered = await gather(
    d,
    { artifacts: [`note:${noteId}`] },
    {
      readNote: readNote('2026-09-02'),
      listPromotedNotes: async () => {
        promotedNoteReads += 1
        return []
      },
    },
    identity,
    [
      {
        kind: 'task-open-with-notes',
        deferrable: false,
        expectedExitCode: 0,
        expectedStatus: 'done',
        requirePullRequest: false,
        operatorRuling: false,
      },
    ],
  )
  expect(gathered.notes).toHaveLength(1)
  expect(gathered).not.toHaveProperty('promotedNotes')
  expect(promotedNoteReads).toBe(0)

  const textId = newRecordId()
  d.query(
    `INSERT INTO workflow_step_text
      (record_id,cursor_record_id,step_ordinal,step_slug,body,created_at)
     VALUES (?, ?, 1, 'rebase', 'evidence', '2026-08-01')`,
  ).run(textId, CURSOR_RECORD_ID)
  await expect(gather(d, { artifacts: [`attached-text:${textId}`] })).rejects.toThrow(
    'attached text record time is 2026-08-01',
  )
  d.query('UPDATE workflow_step_text SET created_at=? WHERE record_id=?').run('2026-09-02', textId)
  await expect(gather(d, { artifacts: [`attached-text:${textId}`] })).resolves.toBeDefined()
})

test('only a note promoted to the cursor task on its task-open-with-notes floor is freshness-exempt', async () => {
  const d = database()
  const noteId = newRecordId()
  const closeFloor = [
    {
      kind: 'task-open-with-notes' as const,
      deferrable: false,
      expectedExitCode: 0,
      expectedStatus: 'done',
      requirePullRequest: false,
      operatorRuling: false,
    },
  ]
  const staleNote = (promotedTask: string | null) => async () => ({
    recordId: noteId,
    label: 'fixture#1',
    promotedTask,
    staleAt: null,
    writtenAt: '2026-08-01',
  })

  await expect(
    gather(
      d,
      { artifacts: [`note:${noteId}`] },
      { readNote: staleNote('DEV-977') },
      identity,
      closeFloor,
    ),
  ).resolves.toBeDefined()
  await expect(
    gather(
      d,
      { artifacts: [`note:${noteId}`] },
      { readNote: staleNote(null) },
      identity,
      closeFloor,
    ),
  ).rejects.toThrow('note record time is 2026-08-01, before step activation 2026-09-01')
  await expect(
    gather(
      d,
      { artifacts: [`note:${noteId}`] },
      { readNote: staleNote('DEV-978') },
      identity,
      closeFloor,
    ),
  ).rejects.toThrow('note record time is 2026-08-01, before step activation 2026-09-01')
  await expect(
    gather(d, { artifacts: [`note:${noteId}`] }, { readNote: staleNote('DEV-977') }),
  ).rejects.toThrow('note record time is 2026-08-01, before step activation 2026-09-01')
})
