import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { DUPLICATE_TITLE_FIXTURE } from './duplicate-matcher.fixture.ts'
import { writeTrackerCache } from './ingest/trackers.ts'
import { persistInstallBinding } from './install-binding.ts'
import { loadOutboxChange } from './outbox-row.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import {
  closeTask,
  commentTask,
  createTask,
  deleteTaskComment,
  duplicateCandidates,
  duplicateScore,
  editTaskComment,
  setTask,
  setTaskBody,
  showTask,
  taskRecord,
} from './task.ts'
import { UNATTRIBUTED } from './task-attribution.ts'
import { taskBodyVersion } from './task-detail.ts'

beforeAll(resetFixtureStore)

const hosted = {
  baseUrl: 'https://hub.example.test',
  token: 'test',
  fetch: async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const at = new Date().toISOString()
    const key = decodeURIComponent(url.pathname.split('/')[3] ?? '')
    if (url.pathname === '/v1/tasks/identity')
      return Response.json({
        userId: 'user-1',
        activeSpaceId: 'declared-gamma-space',
        memberships: [{ spaceId: 'declared-gamma-space', slug: 'gamma', permission: 'write' }],
        capabilities: {
          spacePush: true,
          spacePushTables: [
            'hub_task',
            'hub_task_comment',
            'hub_task_document',
            'hub_task_status_event',
          ],
        },
      })
    if (url.pathname === '/v1/changes')
      return Response.json(
        (body as Array<{ id: string }>).map(({ id }) => ({ id, status: 'applied' })),
      )
    if (url.pathname === '/v1/tasks') {
      const project = body.project as string
      const prefixes: Record<string, string> = {
        alpha: 'ALP',
        beta: 'BET',
        delta: 'DEL',
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
        next_document_number: 1,
      })
    }
    if (url.pathname.endsWith('/documents'))
      return Response.json({
        id: Bun.randomUUIDv7(),
        task_key: key,
        project_name: 'workshop',
        role: body.role ?? null,
        title: body.title,
        body: body.body,
        version: body.version,
        number: showTask(key).task.next_document_number,
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

describe('hosted-authoritative existing-row edits', () => {
  beforeEach(resetFixtureStore)
  const unreachable = {
    baseUrl: 'https://unreachable.example.test',
    token: 'test',
    fetch: async () => {
      throw new Error('hosted hub unavailable')
    },
  }

  test('set, comment, and close save locally and queue while offline', async () => {
    const id = seed('GAM-70', 'gamma')
    const messages: unknown[] = []
    const stdout: unknown[] = []
    const error = spyOn(console, 'error').mockImplementation((message) => messages.push(message))
    const log = spyOn(console, 'log').mockImplementation((message) => stdout.push(message))
    try {
      await setTask('GAM-70', { recordId: id }, { title: 'Offline title' }, UNATTRIBUTED, {
        hosted: unreachable,
      })
      await commentTask('GAM-70', { recordId: id }, 'offline comment', UNATTRIBUTED, {
        hosted: unreachable,
      })
      await closeTask('GAM-70', { recordId: id }, UNATTRIBUTED, {
        hosted: unreachable,
        classify: async () => ({ ...branchClassification('GAM-70'), project: 'gamma' }),
      })
    } finally {
      error.mockRestore()
      log.mockRestore()
    }
    expect(messages).toEqual([
      expect.stringContaining('hosted change saved and queued'),
      expect.stringContaining('hosted change saved and queued'),
      expect.stringContaining('hosted change saved and queued'),
    ])
    expect(stdout).toEqual([])
    expect(db().query(`SELECT title,status_category FROM task WHERE record_id=?`).get(id)).toEqual({
      title: 'Offline title',
      status_category: 'done',
    })
    expect(
      db()
        .query<{ table_name: string }, []>(
          `SELECT table_name FROM hosted_outbox ORDER BY table_name`,
        )
        .all()
        .map((row) => row.table_name),
    ).toEqual(['hub_task', 'hub_task_comment', 'hub_task_status_event'])
  })

  test('an attributed status change persists attribution locally and in its hosted outbox row', async () => {
    const id = seed('GAM-74', 'gamma')
    const attribution = {
      actorUserId: 'user-1',
      actorName: 'Person',
      agent: 'codex',
      runId: '14372',
    }
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await setTask('GAM-74', { recordId: id }, { status: 'active' }, attribution, {
        hosted: unreachable,
      })
    } finally {
      error.mockRestore()
    }
    const event = db()
      .query<
        {
          record_id: string
          actor_user_id: string | null
          actor_name: string | null
          agent: string | null
          run_id: string | null
        },
        [string]
      >(
        `SELECT record_id,actor_user_id,actor_name,agent,run_id
         FROM task_status_event WHERE task_record_id=?`,
      )
      .get(id)!
    expect(event).toMatchObject({
      actor_user_id: attribution.actorUserId,
      actor_name: attribution.actorName,
      agent: attribution.agent,
      run_id: attribution.runId,
    })
    const pointer = db()
      .query<{ table_name: string; row_id: string; operation: 'upsert' | 'delete' }, [string]>(
        `SELECT table_name,row_id,operation FROM hosted_outbox WHERE row_id=?`,
      )
      .get(event.record_id)!
    const change = loadOutboxChange(db(), pointer)!.change
    expect(change.table).toBe('hub_task_status_event')
    if (change.table !== 'hub_task_status_event' || change.op !== 'upsert')
      throw new Error('expected status event upsert')
    expect(change.row).toMatchObject({
      actor_user_id: attribution.actorUserId,
      actor_name: attribution.actorName,
      agent: attribution.agent,
      run_id: attribution.runId,
    })
  })

  test('an applied or rejected after-write drain reports its outcome and keeps rejections', async () => {
    const sentId = seed('GAM-71', 'gamma')
    const rejectedId = seed('GAM-72', 'gamma')
    let reject = false
    const fetch = async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/v1/tasks/identity')
        return Response.json({
          userId: 'user-1',
          activeSpaceId: 'declared-gamma-space',
          memberships: [{ spaceId: 'declared-gamma-space', slug: 'gamma', permission: 'write' }],
          capabilities: { spacePush: true, spacePushTables: ['hub_task'] },
        })
      const changes = JSON.parse(String(init?.body)) as Array<{ id: string }>
      return Response.json(
        changes.map(({ id }) =>
          reject ? { id, status: 'rejected', reason: 'policy says no' } : { id, status: 'applied' },
        ),
      )
    }
    const messages: unknown[] = []
    const stdout: unknown[] = []
    const error = spyOn(console, 'error').mockImplementation((message) => messages.push(message))
    const log = spyOn(console, 'log').mockImplementation((message) => stdout.push(message))
    try {
      const hosted = { baseUrl: 'https://hub.example.test', token: 'test', fetch }
      await setTask('GAM-71', { recordId: sentId }, { title: 'Sent' }, UNATTRIBUTED, { hosted })
      reject = true
      await setTask('GAM-72', { recordId: rejectedId }, { title: 'Rejected' }, UNATTRIBUTED, {
        hosted,
      })
    } finally {
      error.mockRestore()
      log.mockRestore()
    }
    expect(messages).toEqual([
      'hosted change sent',
      `hosted change rejected: policy says no; inspect it with \`${PLATFORM_SLUG} record outbox\``,
    ])
    expect(stdout).toEqual([])
    expect(
      db().query(`SELECT last_error FROM hosted_outbox WHERE row_id=?`).get(rejectedId),
    ).toEqual({
      last_error: 'policy says no',
    })
  })

  test('an after-write drain held by the collector reports saved and queued without sending', async () => {
    const id = seed('GAM-73', 'gamma')
    writeTransaction((conn) =>
      conn
        .query(`INSERT INTO setting(key,value) VALUES ('hosted-outbox.lease',?)`)
        .run(JSON.stringify({ holder: 'outbox:collector', until: Date.now() + 60_000 })),
    )
    const requests: string[] = []
    const messages: unknown[] = []
    const log = spyOn(console, 'error').mockImplementation((message) => messages.push(message))
    try {
      await setTask(
        'GAM-73',
        { recordId: id },
        { title: 'Queued behind collector' },
        UNATTRIBUTED,
        {
          hosted: {
            ...hosted,
            fetch: async (...args) => {
              requests.push(new URL(args[0]).pathname)
              return hosted.fetch(...args)
            },
          },
        },
      )
    } finally {
      log.mockRestore()
    }
    expect(requests).toEqual(['/v1/tasks/identity'])
    expect(messages).toEqual([
      `hosted change saved and queued: another process is draining; the collector fast cycle will send it; inspect it with \`${PLATFORM_SLUG} record outbox\``,
    ])
    expect(db().query(`SELECT 1 FROM hosted_outbox WHERE row_id=?`).get(id)).not.toBeNull()
  })

  test('new still needs hosting and local-authoritative edits queue nothing', async () => {
    await expect(
      createTask({ project: 'gamma', title: 'Cannot create offline' }, { hosted: unreachable }),
    ).rejects.toThrow('hosted hub unavailable')
    const id = seed('BET-70', 'beta')
    await setTask('BET-70', { recordId: id }, { title: 'Local only' }, UNATTRIBUTED, {
      hosted: { baseUrl: '' },
    })
    expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  })
})

describe('local task tracker', () => {
  describe('with hosted comment authorship', () => {
    let previousHostedUrl: string | undefined

    beforeEach(() => {
      previousHostedUrl = process.env.HUB_HOSTED_URL
      process.env.HUB_HOSTED_URL = 'https://hub.example.test'
    })

    afterEach(() => {
      if (previousHostedUrl === undefined) delete process.env.HUB_HOSTED_URL
      else process.env.HUB_HOSTED_URL = previousHostedUrl
    })

    test('comment authors may edit and delete while other record users are refused', async () => {
      resetFixtureStore()
      const key = 'BET-AUTHOR'
      seed(key, 'beta')
      const author = { actorUserId: 'user-1', actorName: 'Person', agent: 'codex', runId: '42' }
      const other = { ...author, actorUserId: 'user-2' }
      const comment = await commentTask(key, {}, 'first', author)
      await expect(editTaskComment(key, {}, comment.id, 'first', author)).rejects.toThrow(
        'unchanged',
      )
      await expect(editTaskComment(key, {}, comment.id, '', author)).rejects.toThrow('required')
      await expect(editTaskComment(key, {}, comment.id, 'other', other)).rejects.toThrow(
        'another author',
      )
      await expect(
        editTaskComment(key, {}, comment.id, 'unknown identity', {
          ...author,
          actorUserId: null,
        }),
      ).rejects.toThrow('record sign-in')
      await writeTransaction((conn) =>
        conn.query(`UPDATE task_comment SET actor_user_id=NULL WHERE record_id=?`).run(comment.id),
      )
      await expect(editTaskComment(key, {}, comment.id, 'older', author)).rejects.toThrow(
        'predates recorded authorship',
      )
      await writeTransaction((conn) =>
        conn
          .query(`UPDATE task_comment SET actor_user_id=? WHERE record_id=?`)
          .run(author.actorUserId, comment.id),
      )
      const beforeEdit = db()
        .query<{ generation: number }, [string]>(
          `SELECT generation FROM hosted_outbox WHERE table_name='hub_task_comment' AND row_id=?`,
        )
        .get(comment.id)!
      await editTaskComment(key, {}, comment.id, 'edited', author)
      const afterEdit = db()
        .query<{ generation: number }, [string]>(
          `SELECT generation FROM hosted_outbox WHERE table_name='hub_task_comment' AND row_id=?`,
        )
        .get(comment.id)!
      expect(afterEdit.generation).toBeGreaterThan(beforeEdit.generation)
      expect(showTask(key).comments[0]).toMatchObject({
        body: 'edited',
        actor_name: 'Person',
        agent: 'codex',
      })
      await deleteTaskComment(key, {}, comment.id, author)
      expect(
        db()
          .query<{ generation: number }, [string]>(
            `SELECT generation FROM hosted_outbox WHERE table_name='hub_task_comment' AND row_id=?`,
          )
          .get(comment.id)!.generation,
      ).toBeGreaterThan(afterEdit.generation)
      expect(showTask(key).comments).toEqual([])
      await expect(deleteTaskComment(key, {}, comment.id, author)).rejects.toThrow('not found')
    })
  })
  test('a project without a declared space sends no record-space header', async () => {
    let recordSpace: string | null = 'not-called'
    await createTask(
      { project: 'beta', title: `No space ${crypto.randomUUID()}` },
      {
        hosted: {
          ...hosted,
          fetch: async (input, init) => {
            recordSpace = new Headers(init?.headers).get('x-record-space')
            return hosted.fetch(input, init)
          },
        },
      },
    )
    expect(recordSpace).toBeNull()
  })

  test('a hub-protocol project still mints through hub', async () => {
    let write: Record<string, unknown> | null = null
    const task = await createTask(
      { project: 'workshop', title: `Hub-owned ${crypto.randomUUID()}` },
      {
        hosted: {
          ...hosted,
          fetch: async (input, init) => {
            if (new URL(input).pathname === '/v1/tasks' && init?.body)
              write = JSON.parse(String(init.body)) as Record<string, unknown>
            return hosted.fetch(input, init)
          },
        },
      },
    )
    expect(task.key).toMatch(/^DEV-\d+$/)
    expect(task.source).toBe('local')
    expect(write).toMatchObject({
      project: 'workshop',
      projectId: projectRecordIdFor('workshop'),
    })
  })

  test('issues above the highest existing number for the project prefix', async () => {
    seed('BET-700', 'beta')
    expect((await createTask({ project: 'beta', title: 'Next beta task' }, { hosted })).key).toBe(
      'BET-701',
    )
  })

  test('an mcp-sourced key participates in issuance and cannot collide', async () => {
    seed('DEL-900', 'delta', 'mcp')
    const task = await createTask({ project: 'delta', title: 'After tracker task' }, { hosted })
    expect(task.key).toBe('DEL-901')
    expect(showTask('DEL-900').task.source).toBe('mcp')
  })

  test('refuses issuance when the registered project has no prefix', async () => {
    expect(
      createTask({ project: 'nested', title: 'Cannot number this' }, { hosted }),
    ).rejects.toThrow(`${PLATFORM_SLUG} project set nested --settings '{"keyPrefixes":["ABC"]}'`)
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
    writeTrackerCache(
      [
        {
          externalId: 'tracker-local-key',
          key: local.key,
          project: 'gamma',
          title: 'Tracker replacement',
          status: 'done',
          category: 'done',
          updatedAt: '2026-09-02T00:00:00.000Z',
          assignee: 'Tracker Owner',
        },
      ],
      '2026-09-02T00:00:00.000Z',
    )
    const after = showTask(local.key).task
    expect(after.source).toBe('local')
    expect(after.title).toBe('Keep this local')
    expect(after.status_category).toBe('open')
    expect(after.body).toBe('Local body')
    expect(after.assignee).toBe('Local Owner')
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
      next_document_number: 1,
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
    const comment = await commentTask(task.key, {}, 'A useful comment', UNATTRIBUTED, { hosted })
    expect(comment.task_record_id).toBe(task.record_id)
    const ordinaryId = Bun.randomUUIDv7()
    const handoffId = Bun.randomUUIDv7()
    writeTransaction((conn) => {
      const at = new Date().toISOString()
      const insertDocument = conn.query(
        `INSERT INTO task_document
        (record_id,task_key,task_record_id,number,role,title,body,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      insertDocument.run(
        ordinaryId,
        task.key,
        task.record_id,
        1,
        null,
        'Notes',
        '# Notes',
        'ordinary-version',
        at,
        at,
      )
      insertDocument.run(
        handoffId,
        task.key,
        task.record_id,
        2,
        'handoff',
        'Handoff',
        '# Handoff',
        'handoff-version',
        at,
        at,
      )
      conn
        .query(
          `INSERT INTO interval
        (record_id, task_key, project, source, agent, job, start_at, end_at, vendor_tokens, ref, open)
       VALUES (?, ?, 'workshop', 'orch', 'codex', 'implement', ?, ?, 123, 'orch:1812', 0)`,
        )
        .run('interval-root', task.key, '2026-09-05T10:00:00.000Z', '2026-09-05T10:01:00.000Z')
      conn
        .query(
          `INSERT INTO interval
        (record_id, task_key, project, source, agent, job, start_at, end_at, vendor_tokens, ref, open)
       VALUES (?, ?, 'workshop', 'orch', 'codex', 'implement', ?, ?, 45, 'orch:1812:turn:1813', 0)`,
        )
        .run('interval-turn', task.key, '2026-09-05T10:02:00.000Z', '2026-09-05T10:03:00.000Z')
    })

    const result = taskRecord(task.key.toLowerCase())
    expect(result.task).toMatchObject({ key: task.key, title: 'Inspectable task' })
    expect(result.task.source).toBe('local')
    expect(result.capabilities).toMatchObject({
      setStatus: { allowed: true },
      setTitle: { allowed: true },
      setBody: { allowed: true },
      comment: { allowed: true },
      documents: { allowed: true },
    })
    expect(result.comments).toEqual([
      expect.objectContaining({
        id: comment.id,
        body: comment.body,
        createdAt: comment.created_at,
      }),
    ])
    expect(result.documents.map((document) => document.id)).toEqual([handoffId, ordinaryId])
    expect(result.documents[0]?.body).toBe('# Handoff')
    expect(result.runs).toEqual([
      expect.objectContaining({ id: '1813', agent: 'codex' }),
      expect.objectContaining({ id: '1812', agent: 'codex' }),
    ])
    expect(taskRecord(task.key).task.key).toBe(task.key)
  })

  describe('task body compare-and-swap', () => {
    test('writes only the matching version', async () => {
      resetFixtureStore()
      const id = seed(`BODY-${crypto.randomUUID()}`, 'epsilon')
      await setTaskBody('ignored', { recordId: id }, 'first', taskBodyVersion(null))
      const firstVersion = taskBodyVersion('first')
      await setTaskBody('ignored', { recordId: id }, 'second', firstVersion)
      await expect(setTaskBody('ignored', { recordId: id }, 'stale', firstVersion)).rejects.toThrow(
        'body changed since version',
      )
      expect(showTask('ignored', { recordId: id }).task.body).toBe('second')
    })

    const expectCapabilityRefusal = async () => {
      resetFixtureStore()
      const external = seed(`EXT-${crypto.randomUUID()}`, 'alpha', 'mcp')
      await expect(
        setTaskBody('ignored', { recordId: external }, 'no', taskBodyVersion(null)),
      ).rejects.toThrow('No adapter has proven a task description write')
    }

    describe('without a hosted URL', () => {
      let previousHostedUrl: string | undefined

      beforeEach(() => {
        previousHostedUrl = process.env.HUB_HOSTED_URL
        delete process.env.HUB_HOSTED_URL
      })

      afterEach(() => {
        if (previousHostedUrl === undefined) delete process.env.HUB_HOSTED_URL
        else process.env.HUB_HOSTED_URL = previousHostedUrl
      })

      test('honors capability refusal', expectCapabilityRefusal)
    })

    describe('with a hosted URL', () => {
      let previousHostedUrl: string | undefined

      beforeEach(() => {
        previousHostedUrl = process.env.HUB_HOSTED_URL
        process.env.HUB_HOSTED_URL = 'https://hub.example.test'
      })

      afterEach(() => {
        if (previousHostedUrl === undefined) delete process.env.HUB_HOSTED_URL
        else process.env.HUB_HOSTED_URL = previousHostedUrl
      })

      test('honors capability refusal', expectCapabilityRefusal)
    })
  })

  test('task detail joins comments by task identity and orders equal timestamps by UUID', () => {
    const recordId = seed('SAME-77', 'alpha')
    const otherRecordId = seed('SAME-77', 'beta')
    writeTransaction((conn) => {
      conn
        .query(
          `INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at) VALUES
           ('01990000-0000-7000-8000-000000000002','SAME-77',?,'alpha second','2026-09-01'),
           ('01990000-0000-7000-8000-000000000003','SAME-77',?,'beta comment','2026-09-01'),
           ('01990000-0000-7000-8000-000000000001','SAME-77',?,'alpha first','2026-09-01')`,
        )
        .run(recordId, otherRecordId, recordId)
    })
    expect(showTask('SAME-77', { recordId }).comments.map((row) => [row.id, row.body])).toEqual([
      ['01990000-0000-7000-8000-000000000001', 'alpha first'],
      ['01990000-0000-7000-8000-000000000002', 'alpha second'],
    ])
  })
})

describe('declared project space task writes', () => {
  beforeEach(resetFixtureStore)

  test('every canonical task write sends the space declared by the project register', async () => {
    const requests: Array<{ method: string; pathname: string; space: string | null }> = []
    const fetch = async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      const method = init?.method ?? 'GET'
      requests.push({
        method,
        pathname: url.pathname,
        space: new Headers(init?.headers).get('x-record-space'),
      })

      return hosted.fetch(input, init)
    }
    const options = { hosted: { ...hosted, fetch } }
    const title = `Declared space ${crypto.randomUUID()}`

    const created = await createTask({ project: 'gamma', title }, options)
    await createTask(
      { project: 'gamma', title },
      { ...options, allowDuplicateReason: 'intentional duplicate' },
    )
    await setTask(created.key, {}, { title: 'Renamed in declared space' }, UNATTRIBUTED, options)
    await closeTask(created.key, {}, UNATTRIBUTED, {
      ...options,
      classify: async () => branchClassification(created.key),
    })
    await commentTask(created.key, {}, 'declared space comment', UNATTRIBUTED, options)
    expect(requests).toEqual([
      { method: 'POST', pathname: '/v1/tasks', space: 'declared-gamma-space' },
      { method: 'POST', pathname: '/v1/tasks', space: 'declared-gamma-space' },
      ...Array.from({ length: 4 }, () => [
        { method: 'GET', pathname: '/v1/tasks/identity', space: null },
        { method: 'POST', pathname: '/v1/changes', space: 'declared-gamma-space' },
      ]).flat(),
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

  test('mints the next key, then update close and comment write hub.db', async () => {
    const created = await createTask({
      project: 'beta',
      title: `Local-authoritative write ${crypto.randomUUID()}`,
    })
    expect(created.key).toMatch(/^BET-\d+$/)
    expect(created.source).toBe('local')
    expect(created.record_id).toBeTruthy()

    const renamed = await setTask(created.key, {}, { title: 'Renamed local beta' }, UNATTRIBUTED)
    expect(renamed.title).toBe('Renamed local beta')

    const comment = await commentTask(created.key, {}, 'a local comment', UNATTRIBUTED)
    expect(comment.body).toBe('a local comment')
    expect(comment.task_record_id).toBe(created.record_id)

    const closed = await closeTask(created.key, {}, UNATTRIBUTED, {
      classify: async (_project, key) => branchClassification(key),
    })
    expect(closed.status_category).toBe('done')
    expect(closed.closed_at).toBeTruthy()
  })

  test('set refuses a done transition with an unlanded branch without mutating', async () => {
    const created = await createTask({ project: 'beta', title: 'Unlanded set transition' })
    await expect(
      setTask(created.key, {}, { status: 'done' }, UNATTRIBUTED, {
        classify: async (_project, key) =>
          branchClassification(key, [
            {
              branch: `${key}-worker`,
              state: 'unlanded',
              commitsNotOnTrunk: 2,
              command: `git branch -D ${key}-worker`,
            },
          ]),
      }),
    ).rejects.toThrow(`${created.key}-worker: unlanded; 2 commits not on trunk`)
    expect(showTask(created.key).task.status_category).toBe('open')
  })

  test('set allows a done transition when every branch is landed or deleted', async () => {
    const created = await createTask({ project: 'beta', title: 'Landed set transition' })
    const closed = await setTask(created.key, {}, { status: 'done' }, UNATTRIBUTED, {
      classify: async (_project, key) => ({
        ...branchClassification(key),
        wouldDelete: [`${key}-landed`],
      }),
    })
    expect(closed.status_category).toBe('done')
  })

  test('abandon refuses a non-local task before classification or mutation', async () => {
    seed('BET-998', 'beta', 'mcp')
    let classified = false
    await expect(
      setTask('BET-998', {}, { status: 'done' }, UNATTRIBUTED, {
        abandonReason: 'work deliberately abandoned',
        classify: async (_project, key) => {
          classified = true
          return branchClassification(key)
        },
      }),
    ).rejects.toThrow('task BET-998 is not local')
    expect(classified).toBeFalse()
    expect(showTask('BET-998').task.status_category).toBe('open')
  })

  test('a failed abandon comment leaves the task open', async () => {
    const created = await createTask({ project: 'beta', title: 'Failed abandon comment' })
    await expect(
      setTask(created.key, {}, { status: 'done' }, UNATTRIBUTED, {
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
      }),
    ).rejects.toThrow('comment write failed')
    expect(showTask(created.key).task.status_category).toBe('open')
  })

  test('a remote-tracker project refuses local writes when hosting is absent', async () => {
    await expect(createTask({ project: 'alpha', title: 'Must not mint locally' })).rejects.toThrow(
      "project 'alpha' owns task creation in its tracker",
    )
  })

  test('a hosted-bound install with HUB_HOSTED_URL unset refuses hub-protocol writes', async () => {
    writeTransaction((conn) => persistInstallBinding(conn, 'space-a'))
    await expect(
      createTask({ project: 'workshop', title: 'Must not mint locally on a bound install' }),
    ).rejects.toThrow("project 'workshop' belongs to a hosted space")
  })

  test('a hosted-space task remains readable when hosting is unavailable', () => {
    writeTransaction((conn) => persistInstallBinding(conn, 'space-a'))
    const recordId = seed('DEV-READ-OFFLINE', 'workshop')
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task_comment
           (record_id,task_key,task_record_id,body,created_at,actor_user_id)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          Bun.randomUUIDv7(),
          'DEV-READ-OFFLINE',
          recordId,
          'still readable',
          new Date().toISOString(),
          'user-1',
        ),
    )

    const result = taskRecord('DEV-READ-OFFLINE', {}, 'user-1')
    expect(result.comments).toEqual([expect.objectContaining({ canEdit: false, canDelete: false })])
  })

  test('a never-bound project with no key prefix is refused locally', async () => {
    await expect(
      createTask({ project: 'nested', title: 'Cannot number this locally' }),
    ).rejects.toThrow(`${PLATFORM_SLUG} project set nested --settings '{"keyPrefixes":["ABC"]}'`)
  })
})
