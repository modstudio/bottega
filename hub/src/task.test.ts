import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { declareFixtureProjectSpace } from '../test/fixture-project-space.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { DUPLICATE_TITLE_FIXTURE } from './duplicate-matcher.fixture.ts'
import { duplicateScore } from './duplicate-score.ts'
import { HOSTED_UNREACHABLE_REMEDY } from './hosted-write-mode.ts'
import { writeTrackerCache } from './ingest/trackers.ts'
import { persistInstallBinding } from './install-binding.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import {
  closeTask,
  commentTask,
  createTask,
  duplicateCandidates,
  listTasks,
  lookupTasks,
  setTask,
  setTaskBody,
  showTask,
  taskRecord,
} from './task.ts'
import { UNATTRIBUTED } from './task-attribution.ts'
import { taskBodyVersion } from './task-detail.ts'
import { hostedTaskWriteOptions } from './task-write-destination.ts'

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
    if (init?.method !== 'POST' && url.pathname.startsWith('/v1/tasks/')) {
      const task = db()
        .query<Record<string, unknown>, [string, string]>(
          `SELECT record_id id,key,project,project project_name,title,status,status_category,
                  parent_key,parent_record_id parent_id,body,assignee,opened_at,closed_at,source,first_seen,last_seen,
                  first_seen created_at,last_seen updated_at,next_document_number
             FROM task WHERE record_id=? OR key=?`,
        )
        .get(key, key)
      if (!task) return Response.json({ error: 'missing' }, { status: 404 })
      const taskId = String(task.id)
      const comments = db()
        .query<Record<string, unknown>, [string]>(
          `SELECT record_id id,task_key,task_record_id task_id,body,created_at,updated_at,deleted_at,
                  actor_user_id,actor_name,agent,run_id FROM task_comment WHERE task_record_id=?`,
        )
        .all(taskId)
      const documents = db()
        .query<Record<string, unknown>, [string]>(
          `SELECT record_id id,number,task_key,task_record_id task_id,role,title,body,version,
                  created_at,updated_at,NULL deleted_at FROM task_document WHERE task_record_id=?`,
        )
        .all(taskId)
      return Response.json({
        task: { ...task, deleted_at: null, revision: 1 },
        comments,
        documents,
      })
    }
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
      const parentId = body.parent
        ? (db()
            .query<{ record_id: string }, [string]>('SELECT record_id FROM task WHERE key=?')
            .get(body.parent as string)?.record_id ?? null)
        : null
      return Response.json({
        id: Bun.randomUUIDv7(),
        key: taskKey,
        project,
        project_name: project,
        title: body.title,
        status: body.status,
        status_category: body.status,
        parent_key: body.parent ?? null,
        parent_id: parentId,
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
        number: (await showTask(key)).task.next_document_number,
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

  test('an unreachable hosted record refuses without changing the local row or outbox', async () => {
    const id = seed('GAM-79', 'gamma')
    const fetch = async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('record unavailable')
      const response = await hosted.fetch(input, init)
      return response
    }

    const refused = await setTask('GAM-79', { recordId: id }, { status: 'active' }, UNATTRIBUTED, {
      hosted: { ...hosted, fetch },
    }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toContain(HOSTED_UNREACHABLE_REMEDY)
    expect((refused as Error).message).not.toContain('saved and queued')
    expect(db().query(`SELECT status_category FROM task WHERE record_id=?`).get(id)).toEqual({
      status_category: 'open',
    })
    expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
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

  test('an unreachable duplicate-reason comment refuses without queuing it', async () => {
    const fetch = async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === '/v1/changes') throw new Error('record unavailable')
      return hosted.fetch(input, init)
    }

    await expect(
      createTask(
        { project: 'gamma', title: `Duplicate reason ${crypto.randomUUID()}` },
        {
          allowDuplicateReason: 'operator confirmed the tasks are distinct',
          hosted: { ...hosted, fetch },
        },
      ),
    ).rejects.toThrow(HOSTED_UNREACHABLE_REMEDY)
    expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)
  })
})

describe('local task tracker', () => {
  declareFixtureProjectSpace('beta', 'space-beta')
  declareFixtureProjectSpace('delta', 'space-delta')
  declareFixtureProjectSpace('workshop', 'space-workshop')
  test('a project without a declared space refuses with the declaration remedy', () => {
    expect(() => hostedTaskWriteOptions('alpha', hosted)).toThrow(
      `${PLATFORM_SLUG} project set alpha --space <slug>`,
    )
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
    expect((await showTask('DEL-900')).task.source).toBe('mcp')
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
    expect((await showTask(child.key)).task.parent_key).toBe(parent.key)
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
      [],
    )
    const after = (await showTask(local.key)).task
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
      retired_reason: null,
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
      expect((await showTask('ignored', { recordId: id })).task.body).toBe('second')
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
        previousHostedUrl = process.env.BOTTEGA_HOSTED_URL
        delete process.env.BOTTEGA_HOSTED_URL
      })

      afterEach(() => {
        if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
        else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
      })

      test('honors capability refusal', expectCapabilityRefusal)
    })
  })

  test('task detail joins comments by task identity and orders equal timestamps by UUID', async () => {
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
    expect(
      (await showTask('SAME-77', { recordId })).comments.map((row) => [row.id, row.body]),
    ).toEqual([
      ['01990000-0000-7000-8000-000000000001', 'alpha first'],
      ['01990000-0000-7000-8000-000000000002', 'alpha second'],
    ])
  })

  test('task-child display keys never override their task UUID links', async () => {
    const linkedId = seed('LINK-1', 'alpha')
    const labelId = seed('LABEL-2', 'alpha')
    writeTransaction((conn) => {
      conn
        .query(`UPDATE task SET parent_key='LABEL-2',parent_record_id=? WHERE record_id=?`)
        .run(linkedId, labelId)
      conn
        .query(
          `INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at) VALUES
           ('01990000-0000-7000-8000-000000000101','LABEL-2',?,'linked comment','2026-09-01')`,
        )
        .run(linkedId)
      conn
        .query(
          `INSERT INTO task_document
           (record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
           VALUES ('01990000-0000-7000-8000-000000000102','LABEL-2',?,1,'linked document','body','v1','2026-09-01','2026-09-01')`,
        )
        .run(linkedId)
      conn
        .query(
          `INSERT INTO task_status_event(record_id,task_key,task_record_id,at,to_status)
           VALUES ('01990000-0000-7000-8000-000000000103','LABEL-2',?,'2026-09-01','active')`,
        )
        .run(linkedId)
    })

    const linked = await taskRecord('LINK-1', { recordId: linkedId })
    const label = await taskRecord('LABEL-2', { recordId: labelId })
    expect(linked.comments.map((row) => row.body)).toEqual(['linked comment'])
    expect(linked.documents.map((row) => row.title)).toEqual(['linked document'])
    expect(linked.statusEvents.map((row) => row.toStatus)).toEqual(['active'])
    expect(label.comments).toEqual([])
    expect(label.documents).toEqual([])
    expect(label.statusEvents).toEqual([])
    expect((await listTasks({ parent: 'LINK-1' })).map((row) => row.record_id)).toEqual([labelId])
    expect(await listTasks({ parent: 'LABEL-2' })).toEqual([])
  })
})

describe('local-authoritative task writes', () => {
  const previousHostedUrl = process.env.BOTTEGA_HOSTED_URL
  beforeAll(() => {
    delete process.env.BOTTEGA_HOSTED_URL
  })
  beforeEach(resetFixtureStore)
  afterAll(() => {
    if (previousHostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
    else process.env.BOTTEGA_HOSTED_URL = previousHostedUrl
  })

  test('local lookup returns a deduplicated requested task with its ancestor chain', async () => {
    const root = await createTask(
      { project: 'beta', title: 'Lookup root' },
      { skipDuplicateCheck: true },
    )
    const parent = await createTask(
      { project: 'beta', title: 'Lookup parent', parent: root.key },
      { skipDuplicateCheck: true },
    )
    const leaf = await createTask(
      { project: 'beta', title: 'Lookup leaf', parent: parent.key },
      { skipDuplicateCheck: true },
    )

    const found = await lookupTasks('beta', [leaf.key.toLowerCase(), leaf.key, 'BET-999999'])

    expect(found.map(({ key }) => key).sort()).toEqual([root.key, parent.key, leaf.key].sort())
    expect(found.find(({ key }) => key === root.key)?.has_children).toBe(true)
    expect(found.find(({ key }) => key === parent.key)?.has_children).toBe(true)
    expect(found.find(({ key }) => key === leaf.key)?.has_children).toBe(false)
    expect(found.some(({ key }) => key === 'BET-999999')).toBe(false)
    expect(found.every((row) => !('body' in row) && !('source' in row))).toBe(true)
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
    expect((await showTask(created.key)).task.status_category).toBe('open')
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
    expect((await showTask('BET-998')).task.status_category).toBe('open')
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
    expect((await showTask(created.key)).task.status_category).toBe('open')
  })

  test('a remote-tracker project refuses local writes when hosting is absent', async () => {
    await expect(createTask({ project: 'alpha', title: 'Must not mint locally' })).rejects.toThrow(
      "project 'alpha' owns task creation in its tracker",
    )
  })

  test('a hosted-bound install with BOTTEGA_HOSTED_URL unset refuses hub-protocol writes', async () => {
    writeTransaction((conn) => persistInstallBinding(conn, 'space-a'))
    await expect(
      createTask({ project: 'workshop', title: 'Must not mint locally on a bound install' }),
    ).rejects.toThrow("project 'workshop' belongs to a hosted space")
  })

  test('a hosted-space task remains readable when hosting is unavailable', async () => {
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

    const result = await taskRecord('DEV-READ-OFFLINE', {}, 'user-1')
    expect(result.comments).toEqual([expect.objectContaining({ canEdit: false, canDelete: false })])
  })

  test('a never-bound project with no key prefix is refused locally', async () => {
    await expect(
      createTask({ project: 'nested', title: 'Cannot number this locally' }),
    ).rejects.toThrow(`${PLATFORM_SLUG} project set nested --settings '{"keyPrefixes":["ABC"]}'`)
  })
})
