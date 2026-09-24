import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import type { RegisteredProject } from '../projects.ts'
import { createProjectRouter } from './routers/project.ts'

beforeAll(resetFixtureStore)

/**
 * bun:test `mock.module` must intercept `hub/src/orch.ts` before the doc router
 * loads it. appRouter is imported only after the mock; project.list does not
 * touch orch and needs no mock.
 */
const docList = mock(async (_filters?: unknown) => [] as unknown[])
const docGet = mock(
  async (_scope: string, _subject: string | null, _slug: string) => ({}) as unknown,
)
const docSet = mock(async (_input: unknown) => ({}) as unknown)
const docRemove = mock(
  async (_scope: string, _subject: string | null, _slug: string, _reason: string) => ({
    removed: false,
  }),
)
const docHistory = mock(
  async (_scope: string, _subject: string | null, _slug: string) => [] as unknown[],
)
const docSubjects = mock(async () => ({
  project: [] as string[],
  agent: [] as string[],
  job: [] as string[],
}))
const jobs = mock(async () => [])
const agents = mock(async () => [])
const health = mock(async () => ({
  header: 'Harness health only — never routing evidence.',
  days: 14,
  from: '2026-08-24T00:00:00.000Z',
  classes: [
    {
      kind: 'interrupted',
      count: 2,
      totalTimeMs: 1_000,
      meanTimeMs: 500,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-02T00:00:00.000Z',
      clusters: [],
      sparkline: [{ day: '2026-09-02', count: 2 }],
    },
  ],
  falseVerdicts: [],
  landingRefusals: 1,
  mcpProbeFailures: 0,
  mcpUnprobed: 0,
  contention: { resources: [], sessions: [] },
}))

mock.module('../orch.ts', () => ({
  docList,
  docGet,
  docSet,
  docRemove,
  docHistory,
  docSubjects,
  jobs,
  agents,
  health,
}))

const { appRouter } = await import('./router.ts')
const { createWorkRouter } = await import('./routers/work.ts')
const caller = appRouter.createCaller({})

const row = {
  id: 1,
  scope: 'global' as const,
  subject: null,
  slug: 'hello',
  title: 'Hello',
  body: 'Hi',
  delivery: 'inject' as const,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('project.list', () => {
  test('returns the project register rows', async () => {
    const rows = await caller.project.list()

    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({
      id: 1,
      name: 'alpha',
      path: '/fixtures/repos/alpha',
      stack: null,
      canon: true,
      settings: {
        keyPrefixes: ['ALP'],
        color: '#112233',
        colorDark: '#aabbcc',
        tracker: {
          protocol: 'workspace-mcp',
          envPrefix: 'FIXTURE_NO_CREDENTIALS',
          openStatuses: ['started'],
          states: { started: 'active', completed: 'done' },
        },
      },
      trackerStatus: {
        state: 'configured',
        label: 'workspace-mcp',
        error: null,
      },
    })
  })
})

describe('insight.health', () => {
  test('renders its response from the stubbed orch client', async () => {
    const response = await caller.insight.health({
      hours: 168,
      filters: { agent: '', project: '' },
    })
    expect(health).toHaveBeenCalledWith(7)
    expect(response.view).toBe('health')
    expect(response.data.classes[0]?.kind).toBe('interrupted')
    expect(response.data.landingRefusals).toBe(1)
  })
})

describe('hosted page inputs', () => {
  test('new hosted procedures refuse malformed bodies before reading the record', async () => {
    await expect(caller.record.notes({ stale: 'yes' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      caller.record.ratio({ hours: 12, filters: { agent: '', project: '', source: '' } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.record.spend({ hours: 24, filters: { agent: '', project: '', source: 7 } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.record.settings({ hours: 1 } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    const update = {
      id: '01990000-0000-7000-8000-000000000768',
      cadence: 'daily',
      hour: 9,
      zone: 'America/New_York',
      enabled: true,
    }
    await expect(
      caller.record.updateReportSubscription({ ...update, scope: { kind: 'space' } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.record.updateReportSubscription({ ...update, recipientUserIds: ['someone'] } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('work.task', () => {
  const fakeStrip = (() => ({})) as never
  const fakeView = (async () => ({})) as never

  test('returns the canonical task record', async () => {
    const record = {
      task: { key: 'DEV-1' },
      source: 'local',
      project: null,
      runs: [],
      comments: [],
      documents: [],
    }
    const router = createWorkRouter({
      strip: fakeStrip,
      view: fakeView,
      taskRecord: () => record as never,
    })
    const result = await router.createCaller({}).task({ key: 'DEV-1', scope: {} })
    expect(result.task.key).toBe('DEV-1')
    expect(result.source).toBe('local')
  })

  test('passes record id and project identity to local task reads', async () => {
    const seen: unknown[] = []
    const router = createWorkRouter({
      strip: fakeStrip,
      view: fakeView,
      taskRecord: ((key: string, scope: unknown) => {
        seen.push(key, scope)
        return {
          task: { key },
          source: 'local',
          project: null,
          runs: [],
          comments: [],
          documents: [],
        }
      }) as never,
    })
    await router
      .createCaller({})
      .task({ key: 'SAME-1', scope: { project: 'alpha', recordId: 'task-alpha' } })
    expect(seen).toEqual(['SAME-1', { project: 'alpha', recordId: 'task-alpha' }])
  })

  test('maps an unknown key to NOT_FOUND', async () => {
    const router = createWorkRouter({
      strip: fakeStrip,
      view: fakeView,
      taskRecord: () => {
        throw new Error('no task DEV-404')
      },
    })
    await expect(router.createCaller({}).task({ key: 'DEV-404', scope: {} })).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
        message: 'no task DEV-404',
      },
    )
  })

  test('each local write mutation preserves the non-local refusal', async () => {
    const refusal = () => {
      throw new Error('task EXT-1 is not local')
    }
    const router = createWorkRouter({
      strip: fakeStrip,
      view: fakeView,
      setTask: refusal as never,
      commentTask: refusal as never,
      updateTaskDocument: refusal as never,
    })
    const writes = router.createCaller({})
    await expect(
      writes.setStatus({ key: 'EXT-1', scope: {}, status: 'active' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'task EXT-1 is not local',
    })
    await expect(writes.setTitle({ key: 'EXT-1', scope: {}, title: 'No' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'task EXT-1 is not local',
    })
    await expect(writes.comment({ key: 'EXT-1', scope: {}, body: 'No' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'task EXT-1 is not local',
    })
    await expect(
      writes.setDocument({ id: 1, title: 'No', body: 'No', version: 'old' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'task EXT-1 is not local' })
  })

  test('a write to a missing task maps to NOT_FOUND', async () => {
    const router = createWorkRouter({
      strip: fakeStrip,
      view: fakeView,
      setTask: (() => {
        throw new Error('no task DEV-404')
      }) as never,
    })
    await expect(
      router.createCaller({}).setStatus({ key: 'DEV-404', scope: {}, status: 'active' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'no task DEV-404' })
  })

  test('a stale document reports both versions without retrying the write', async () => {
    let writes = 0
    const router = createWorkRouter({
      strip: fakeStrip,
      view: fakeView,
      updateTaskDocument: (() => {
        writes++
        throw new Error('task document 1 changed since version old; read it again')
      }) as never,
      getTaskDocument: (() => ({ version: 'new' })) as never,
    })
    await expect(
      router.createCaller({}).setDocument({
        id: 1,
        title: 'Draft',
        body: 'Kept text',
        version: 'old',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'This document changed since you opened it (version old → new). Reload to see the current version; your edit was not saved.',
    })
    expect(writes).toBe(1)
  })
})

describe('doc router', () => {
  test('list passes filters through to docList', async () => {
    docList.mockResolvedValueOnce([row])
    const rows = await caller.doc.list({ scope: 'global' })
    expect(docList).toHaveBeenCalledWith({ scope: 'global' })
    expect(rows).toEqual([row])
  })

  test('get passes scope, subject and slug to docGet', async () => {
    docGet.mockResolvedValueOnce(row)
    const got = await caller.doc.get({ scope: 'global', subject: null, slug: 'hello' })
    expect(docGet).toHaveBeenCalledWith('global', null, 'hello')
    expect(got).toEqual(row)
  })

  test('set passes the input to docSet', async () => {
    const input = {
      scope: 'global' as const,
      subject: null,
      slug: 'hello',
      title: 'Hello',
      body: 'Hi',
      reason: 'updated',
    }
    docSet.mockResolvedValueOnce(row)
    const got = await caller.doc.set(input)
    expect(docSet).toHaveBeenCalledWith(input)
    expect(got).toEqual(row)
  })

  test('remove passes scope, subject and slug to docRemove', async () => {
    docRemove.mockResolvedValueOnce({ removed: true })
    const got = await caller.doc.remove({
      scope: 'global',
      subject: null,
      slug: 'hello',
      reason: 'obsolete',
    })
    expect(docRemove).toHaveBeenCalledWith('global', null, 'hello', 'obsolete')
    expect(got).toEqual({ removed: true })
  })

  test('set and remove require a non-empty reason, and history forwards the address', async () => {
    await expect(
      caller.doc.set({
        scope: 'global',
        subject: null,
        slug: 'hello',
        title: 'Hello',
        body: 'Hi',
        reason: ' ',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.doc.remove({
        scope: 'global',
        subject: null,
        slug: 'hello',
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const revisions = [
      {
        id: 1,
        op: 'create' as const,
        author: 'tester',
        reason: 'created',
        at: '2026-09-04T00:00:00.000Z',
        bytes: 2,
      },
    ]
    docHistory.mockResolvedValueOnce(revisions)
    expect(await caller.doc.history({ scope: 'global', subject: null, slug: 'hello' })).toEqual(
      revisions,
    )
    expect(docHistory).toHaveBeenCalledWith('global', null, 'hello')
  })

  test('subjects returns what docSubjects returns', async () => {
    const subjects = { project: ['alpha'], stack: ['bun'], agent: ['codex'], job: ['implement'] }
    docSubjects.mockResolvedValueOnce(subjects)
    expect(await caller.doc.subjects()).toEqual(subjects)
    expect(docSubjects).toHaveBeenCalled()
  })

  test("orch errors surface as BAD_REQUEST with orch's message", async () => {
    docGet.mockRejectedValueOnce(new Error('orch doc exited 1: invalid slug; use 1-64 lowercase'))
    let thrown: unknown
    try {
      await caller.doc.get({ scope: 'global', subject: null, slug: 'Bad' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'invalid slug; use 1-64 lowercase',
    })
  })
})

describe('project writes', () => {
  const row: RegisteredProject = {
    id: 10,
    name: 'new-project',
    path: '/tmp/new-project',
    stack: 'bun',
    canon: true,
    settings: {},
  }

  test('add forwards its validated input to the injected orch function', async () => {
    let received: unknown
    const router = createProjectRouter({
      add: async (input) => {
        received = input
        return row
      },
      set: async () => row,
      remove: async () => {},
    })
    const result = await router.createCaller({}).add({
      path: row.path,
      name: row.name,
      stack: row.stack!,
      canon: false,
    })
    expect(received).toEqual({ path: row.path, name: row.name, stack: 'bun', canon: false })
    expect(result).toEqual(row)
  })

  test('set separates the name and preserves null settings values', async () => {
    let received: unknown
    const router = createProjectRouter({
      add: async () => row,
      set: async (name, body) => {
        received = [name, body]
        return row
      },
      remove: async () => {},
    })
    await router.createCaller({}).set({
      name: row.name,
      settings: { tracker: null },
      canon: true,
    })
    expect(received).toEqual([row.name, { settings: { tracker: null }, canon: true }])
  })

  test('remove forwards the name and surfaces orch errors as BAD_REQUEST', async () => {
    let received: string | undefined
    const router = createProjectRouter({
      add: async () => row,
      set: async () => row,
      remove: async (name) => {
        received = name
        throw new Error('no project "missing"')
      },
    })
    const failure = router.createCaller({}).remove({ name: 'missing' })
    expect(received).toBeUndefined()
    await expect(failure).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'no project "missing"',
    })
    expect(received).toBe('missing')
  })
})
