import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { DUPLICATE_TITLE_FIXTURE } from './duplicate-matcher.fixture.ts'
import { upsertTrackerTask } from './ingest/trackers.ts'
import { persistInstallBinding } from './install-binding.ts'
import {
  closeTask,
  commentTask,
  createTask,
  createTaskDocument,
  deleteTaskDocument,
  duplicateCandidates,
  duplicateScore,
  getTaskDocument,
  setTask,
  showTask,
  taskRecord,
  updateTaskDocument,
} from './task.ts'

beforeAll(resetFixtureStore)

const hosted = {
  baseUrl: 'https://hub.example.test',
  token: 'test',
  fetch: async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const at = new Date().toISOString()
    const key = decodeURIComponent(url.pathname.split('/')[3] ?? '')
    if (url.pathname === '/v1/tasks') {
      const project = body.project as string
      const prefixes: Record<string, string> = {
        alpha: 'ALP',
        beta: 'BET',
        gamma: 'GAM',
        workshop: 'DEV',
      }
      const prefix = prefixes[project]!
      const highest = db()
        .query<{ key: string }, []>(`SELECT key FROM task`)
        .all()
        .reduce((max, row) => {
          const match = new RegExp(`^${prefix}-(\\d+)$`).exec(row.key)
          return match ? Math.max(max, Number(match[1])) : max
        }, 0)
      const taskKey = `${prefix}-${highest + 1}`
      return Response.json({
        id: Bun.randomUUIDv7(),
        key: taskKey,
        project,
        project_name: project,
        title: body.title,
        status: body.status,
        status_category: body.status,
        parent_key: body.parent ?? null,
        body: body.body ?? null,
        assignee: null,
        opened_at: at,
        closed_at: null,
        source: 'local',
        first_seen: at,
        last_seen: at,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      })
    }
    if (url.pathname.endsWith('/comments'))
      return Response.json({
        id: Bun.randomUUIDv7(),
        legacy_local_id: null,
        task_key: key,
        project_name: 'workshop',
        body: body.body,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      })
    if (url.pathname.endsWith('/documents'))
      return Response.json({
        id: Bun.randomUUIDv7(),
        legacy_local_id: null,
        task_key: key,
        project_name: 'workshop',
        role: body.role ?? null,
        title: body.title,
        body: body.body,
        version: body.version,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      })
    return Response.json({ error: 'unexpected test route' }, { status: 500 })
  },
}

const seed = (key: string, project: string, source: 'mcp' | 'local' = 'local') => {
  const stamp = new Date().toISOString()
  const recordId = Bun.randomUUIDv7()
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO task
        (record_id,key, project, title, status, status_category, source, first_seen, last_seen)
       VALUES (?, ?, ?, 'seed', 'open', 'open', ?, ?, ?)`,
      )
      .run(recordId, key, project, source, stamp, stamp),
  )
  return recordId
}

const branchClassification = (
  key: string,
  operator: Array<{
    branch: string
    state: 'unlanded' | 'unknown'
    commitsNotOnTrunk: number
    command: string
  }> = [],
) => ({
  project: 'beta',
  key,
  dryRun: true,
  deleted: [],
  kept: [],
  operator,
  wouldDelete: [],
  errors: [],
})

describe('local task tracker', () => {
  test('issues above the highest existing number for the project prefix', async () => {
    seed('BET-700', 'beta')
    expect((await createTask({ project: 'beta', title: 'Next beta task' }, { hosted })).key).toBe(
      'BET-701',
    )
  })

  test('an mcp-sourced key participates in issuance and cannot collide', async () => {
    seed('ALP-900', 'alpha', 'mcp')
    const task = await createTask({ project: 'alpha', title: 'After tracker task' }, { hosted })
    expect(task.key).toBe('ALP-901')
    expect(showTask('ALP-900').task.source).toBe('mcp')
  })

  test('refuses issuance when the registered project has no prefix', async () => {
    expect(
      createTask({ project: 'nested', title: 'Cannot number this' }, { hosted }),
    ).rejects.toThrow(`orch project set nested --settings '{"keyPrefixes":["ABC"]}'`)
  })

  test('refuses an unusable title at the shared creation boundary', async () => {
    expect(createTask({ project: 'workshop', title: '' }, { hosted })).rejects.toThrow(
      'task title is required',
    )
    expect(createTask({ project: 'workshop', title: ' \n ' }, { hosted })).rejects.toThrow(
      'task title is required',
    )
  })

  test('stores a parent and exposes the child through the same task row', async () => {
    const parent = await createTask({ project: 'workshop', title: 'Parent' }, { hosted })
    const child = await createTask(
      { project: 'workshop', title: 'Child', parent: parent.key },
      { hosted },
    )
    expect(child.parent_key).toBe(parent.key)
    expect(child.record_id).not.toBeNull()
    expect(child.parent_record_id).toBe(parent.record_id)
    expect(showTask(child.key).task.parent_key).toBe(parent.key)
  })

  test('a local task survives the tracker ingest write path', async () => {
    const local = await createTask(
      { project: 'gamma', title: 'Keep this local', body: 'Local body' },
      { hosted },
    )
    writeTransaction((conn) =>
      conn.query(`UPDATE task SET assignee = 'Local Owner' WHERE key = ?`).run(local.key),
    )
    upsertTrackerTask({
      externalId: 'tracker-local-key',
      key: local.key,
      project: 'gamma',
      title: 'Tracker replacement',
      status: 'done',
      category: 'done',
      updatedAt: '2026-09-02T00:00:00.000Z',
      assignee: 'Tracker Owner',
    })
    const after = showTask(local.key).task
    expect(after.source).toBe('local')
    expect(after.title).toBe('Keep this local')
    expect(after.status_category).toBe('open')
    expect(after.body).toBe('Local body')
    expect(after.assignee).toBe('Local Owner')
  })

  test('updates a synchronized document through its hosted record id', async () => {
    const taskRecordId = seed('DEV-884', 'workshop')
    const at = new Date().toISOString()
    const recordId = 'hosted-document-884'
    const inserted = writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task_document
          (record_id,task_key,task_record_id,title,body,version,created_at,updated_at)
          VALUES (?, 'DEV-884', ?, 'Before', 'Body', 'version-before', ?, ?)`,
        )
        .run(recordId, taskRecordId, at, at),
    )
    const requests: Array<{ method: string | undefined; pathname: string }> = []

    await updateTaskDocument(
      Number(inserted.lastInsertRowid),
      { title: 'After' },
      {
        hosted: {
          baseUrl: 'https://hub.example.test',
          token: 'test',
          fetch: async (input, init) => {
            const url = new URL(input)
            requests.push({ method: init?.method, pathname: url.pathname })
            return Response.json({
              id: recordId,
              legacy_local_id: Number(inserted.lastInsertRowid),
              task_key: 'DEV-884',
              project_name: 'workshop',
              role: null,
              title: 'After',
              body: 'Body',
              version: 'version-after',
              created_at: at,
              updated_at: at,
              deleted_at: null,
            })
          },
        },
      },
    )

    expect(requests).toEqual([
      { method: 'PATCH', pathname: `/v1/tasks/DEV-884/documents/${recordId}` },
    ])
  })

  test('duplicate title matching is deterministic, thresholded, and capped at three', () => {
    const tasks = [
      ['DEV-4', 'open', 'alpha beta gamma delta epsilon'],
      ['DEV-3', 'done', 'alpha beta gamma delta zeta'],
      ['DEV-2', 'active', 'alpha beta gamma delta eta'],
      ['DEV-1', 'open', 'alpha beta gamma delta theta'],
      ['DEV-5', 'open', 'unrelated words only'],
    ].map(([key, status, title]) => ({
      record_id: `${key}-record`,
      external_id: null,
      key: key!,
      project: 'workshop',
      status: status!,
      status_category: 'open' as const,
      title: title!,
      parent_key: null,
      parent_record_id: null,
      body: null,
      assignee: null,
      opened_at: null,
      closed_at: null,
      updated_at: null,
      source: 'local' as const,
      first_seen: '',
      last_seen: '',
    }))

    expect(duplicateCandidates(tasks, 'alpha beta gamma delta')).toEqual([
      expect.objectContaining({ key: 'DEV-1' }),
      expect.objectContaining({ key: 'DEV-2' }),
      expect.objectContaining({ key: 'DEV-3' }),
    ])
  })

  test('prints the four known duplicate-matcher measurements', () => {
    const scores = {
      'DEV-209/DEV-210': duplicateScore(
        DUPLICATE_TITLE_FIXTURE['DEV-209'],
        DUPLICATE_TITLE_FIXTURE['DEV-210'],
      ),
      'DEV-265/DEV-266': duplicateScore(
        DUPLICATE_TITLE_FIXTURE['DEV-265'],
        DUPLICATE_TITLE_FIXTURE['DEV-266'],
      ),
      'DEV-293/DEV-294': duplicateScore(
        DUPLICATE_TITLE_FIXTURE['DEV-293'],
        DUPLICATE_TITLE_FIXTURE['DEV-294'],
      ),
      'best unrelated': duplicateScore(
        DUPLICATE_TITLE_FIXTURE['DEV-251'],
        DUPLICATE_TITLE_FIXTURE['DEV-266'],
      ),
    }
    console.log('duplicate matcher scores', scores)
    expect(scores['DEV-209/DEV-210']).toBeGreaterThanOrEqual(0.2)
    expect(scores['DEV-265/DEV-266']).toBeGreaterThanOrEqual(0.2)
    expect(scores['DEV-293/DEV-294']).toBeLessThan(0.2)
    expect(scores['best unrelated']).toBeLessThan(0.2)
  })

  test('work.task returns the local record with comments, documents, runs and project', async () => {
    const task = await createTask(
      { project: 'workshop', title: 'Inspectable task', body: 'Task body' },
      { hosted },
    )
    const comment = await commentTask(task.key, {}, 'A useful comment', { hosted })
    expect(comment.task_record_id).toBe(task.record_id)
    const ordinary = await createTaskDocument(
      { task: task.key, title: 'Notes', body: '# Notes' },
      {},
      { hosted },
    )
    const handoff = await createTaskDocument(
      {
        task: task.key,
        title: 'Handoff',
        body: '# Handoff',
        role: 'handoff',
      },
      {},
      { hosted },
    )
    writeTransaction((conn) => {
      conn
        .query(
          `INSERT INTO interval
        (task_key, project, source, agent, job, start_at, end_at, vendor_tokens, ref, open)
       VALUES (?, 'workshop', 'orch', 'codex', 'implement', ?, ?, 123, 'orch:1812', 0)`,
        )
        .run(task.key, '2026-09-05T10:00:00.000Z', '2026-09-05T10:01:00.000Z')
      conn
        .query(
          `INSERT INTO interval
        (task_key, project, source, agent, job, start_at, end_at, vendor_tokens, ref, open)
       VALUES (?, 'workshop', 'orch', 'codex', 'implement', ?, ?, 45, 'orch:1812:turn:1813', 0)`,
        )
        .run(task.key, '2026-09-05T10:02:00.000Z', '2026-09-05T10:03:00.000Z')
    })

    const result = taskRecord(task.key.toLowerCase())
    expect(result.task).toMatchObject({ key: task.key, title: 'Inspectable task' })
    expect(result.source).toBe('local')
    expect(result.project?.name).toBe('workshop')
    expect(result.capabilities).toMatchObject({
      setStatus: { allowed: true },
      setTitle: { allowed: true },
      comment: { allowed: true },
      documents: { allowed: true },
    })
    expect(result.comments).toEqual([comment])
    expect(result.documents.map((document) => document.id)).toEqual([handoff.id, ordinary.id])
    expect(result.documents[0]?.body).toBe('# Handoff')
    expect(result.runs).toEqual([
      expect.objectContaining({ id: 1813, agent: 'codex', vendor_tokens: 45 }),
      expect.objectContaining({ id: 1812, agent: 'codex', vendor_tokens: 123 }),
    ])
    expect(taskRecord(task.key).task.key).toBe(task.key)
  })

  test('task detail joins children by task record id, not their shared label', () => {
    const recordId = seed('SAME-77', 'alpha')
    const otherRecordId = seed('SAME-77', 'beta')
    writeTransaction((conn) => {
      conn
        .query(
          `INSERT INTO task_comment(task_key,task_record_id,body,created_at) VALUES
           ('SAME-77',?,'alpha comment','2026-09-01'),
           ('SAME-77',?,'beta comment','2026-09-02')`,
        )
        .run(recordId, otherRecordId)
    })
    expect(showTask('SAME-77', { recordId }).comments.map((row) => row.body)).toEqual([
      'alpha comment',
    ])
  })
})

describe('local-authoritative task writes', () => {
  const previousHostedUrl = process.env.HUB_HOSTED_URL
  beforeAll(() => {
    delete process.env.HUB_HOSTED_URL
  })
  beforeEach(resetFixtureStore)
  afterAll(() => {
    if (previousHostedUrl === undefined) delete process.env.HUB_HOSTED_URL
    else process.env.HUB_HOSTED_URL = previousHostedUrl
  })

  test('mints the next key, then update close comment and documents write hub.db', async () => {
    const created = await createTask({
      project: 'beta',
      title: `Local-authoritative write ${crypto.randomUUID()}`,
    })
    expect(created.key).toMatch(/^BET-\d+$/)
    expect(created.source).toBe('local')
    expect(created.record_id).toBeTruthy()

    const renamed = await setTask(created.key, {}, { title: 'Renamed local beta' })
    expect(renamed.title).toBe('Renamed local beta')

    const comment = await commentTask(created.key, {}, 'a local comment')
    expect(comment.body).toBe('a local comment')
    expect(comment.task_record_id).toBe(created.record_id)

    const document = await createTaskDocument(
      {
        task: created.key,
        title: 'Notes',
        body: 'first body',
      },
      {},
    )
    expect(document.body).toBe('first body')
    const updated = await updateTaskDocument(document.id, {
      body: 'second body',
      expectedVersion: document.version,
    })
    expect(updated.body).toBe('second body')
    expect(updated.version).not.toBe(document.version)
    await expect(
      updateTaskDocument(document.id, { body: 'stale', expectedVersion: document.version }),
    ).rejects.toThrow(`task document ${document.id} changed since version ${document.version}`)
    await deleteTaskDocument(document.id)
    expect(() => getTaskDocument(document.id)).toThrow(`no task document ${document.id}`)

    const closed = await closeTask(
      created.key,
      {},
      {
        classify: async (_project, key) => branchClassification(key),
      },
    )
    expect(closed.status_category).toBe('done')
    expect(closed.closed_at).toBeTruthy()
  })

  test('set refuses a done transition with an unlanded branch without mutating', async () => {
    const created = await createTask({ project: 'beta', title: 'Unlanded set transition' })
    await expect(
      setTask(
        created.key,
        {},
        { status: 'done' },
        {
          classify: async (_project, key) =>
            branchClassification(key, [
              {
                branch: `${key}-worker`,
                state: 'unlanded',
                commitsNotOnTrunk: 2,
                command: `git branch -D ${key}-worker`,
              },
            ]),
        },
      ),
    ).rejects.toThrow(`${created.key}-worker: unlanded; 2 commits not on trunk`)
    expect(showTask(created.key).task.status_category).toBe('open')
  })

  test('set allows a done transition when every branch is landed or deleted', async () => {
    const created = await createTask({ project: 'beta', title: 'Landed set transition' })
    const closed = await setTask(
      created.key,
      {},
      { status: 'done' },
      {
        classify: async (_project, key) => ({
          ...branchClassification(key),
          wouldDelete: [`${key}-landed`],
        }),
      },
    )
    expect(closed.status_category).toBe('done')
  })

  test('abandon refuses a non-local task before classification or mutation', async () => {
    seed('BET-998', 'beta', 'mcp')
    let classified = false
    await expect(
      setTask(
        'BET-998',
        {},
        { status: 'done' },
        {
          abandonReason: 'work deliberately abandoned',
          classify: async (_project, key) => {
            classified = true
            return branchClassification(key)
          },
        },
      ),
    ).rejects.toThrow('task BET-998 is not local')
    expect(classified).toBeFalse()
    expect(showTask('BET-998').task.status_category).toBe('open')
  })

  test('a failed abandon comment leaves the task open', async () => {
    const created = await createTask({ project: 'beta', title: 'Failed abandon comment' })
    await expect(
      setTask(
        created.key,
        {},
        { status: 'done' },
        {
          abandonReason: 'work deliberately abandoned',
          classify: async (_project, key) =>
            branchClassification(key, [
              {
                branch: `${key}-worker`,
                state: 'unlanded',
                commitsNotOnTrunk: 1,
                command: `git branch -D ${key}-worker`,
              },
            ]),
          comment: async () => {
            throw new Error('comment write failed')
          },
        },
      ),
    ).rejects.toThrow('comment write failed')
    expect(showTask(created.key).task.status_category).toBe('open')
  })

  test('a remote-tracker project refuses local writes when hosting is absent', async () => {
    await expect(createTask({ project: 'alpha', title: 'Must not mint locally' })).rejects.toThrow(
      "project 'alpha' declares a remote tracker",
    )
  })

  test('a hosted-bound install with HUB_HOSTED_URL unset refuses hub-protocol writes', async () => {
    writeTransaction((conn) => persistInstallBinding(conn, 'space-a'))
    await expect(
      createTask({ project: 'workshop', title: 'Must not mint locally on a bound install' }),
    ).rejects.toThrow("project 'workshop' belongs to a hosted space")
  })

  test('a never-bound project with no key prefix is refused locally', async () => {
    await expect(
      createTask({ project: 'nested', title: 'Cannot number this locally' }),
    ).rejects.toThrow(`orch project set nested --settings '{"keyPrefixes":["ABC"]}'`)
  })
})
