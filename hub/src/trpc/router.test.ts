import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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
  async (
    _scope: string,
    _subject: string | null,
    _slug: string,
    _reason: string,
    _expectedRevision?: string,
  ) => ({ removed: false }),
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
const userDocList = mock(async () => [] as unknown[])
const userDocGet = mock(async (_slug: string, _scope?: string) => row)
const userDocSet = mock(async (_input: unknown, _scope?: string) => row)
const userDocRemove = mock(async () => ({ removed: true }))
const contextGet = mock(async (_cwd: string) => ({
  registered: true as const,
  project: 'alpha',
  rulings: { value: 'user' as const, scope: 'built-in' },
  shipTo: {
    value: 'trunk' as const,
    scope: 'built-in',
    landing: 'main',
    production: null,
  },
  stages: [
    {
      stage: 'review' as const,
      agreed: true as const,
      value: 'review' as 'ask' | 'review' | 'auto',
      scope: 'built-in',
      steps: 1,
    },
  ],
  text: 'Autonomy for alpha',
}))
const configSet = mock(async (key: string, value: string, _expected?: number | null) => ({
  key,
  value,
}))
const configList = mock(
  async () =>
    [] as Array<{
      key: string
      environment: string
      scope: 'user' | 'space'
      value: string
      rowVersion: number
      updatedAt: string
    }>,
)
const configDelete = mock(async (_key: string, _expected?: number) => '')
const machineConfigList = mock(
  async () => [] as Array<{ key: string; value: string; scope: 'local user' }>,
)
const machineConfigSet = mock(async (key: string, value: string) => ({
  key,
  value,
  scope: 'local user' as const,
}))
const machineConfigDelete = mock(async (_key: string) => '')
const machinePermissions = mock(async () => ({
  additions: { allow: [] as string[], ask: [] as string[], deny: [] as string[] },
  drop: { allow: [] as string[], ask: [] as string[], deny: [] as string[] },
}))
const machinePermission = mock(async (_input: unknown) => ({
  changed: true,
  counts: { allow: 1, ask: 0, deny: 0 },
  message: 'updated machine permissions',
}))
const settingsCheck = mock(async (_target: unknown) => ({
  target: { kind: 'user' as const },
  file: { path: '/tmp/settings.json', exists: true },
  revision: 'revision-1',
  settings: { permissions: { allow: [], ask: [], deny: [] }, hooks: [], envKeys: [] },
  drift: {
    rules: {
      allow: { added: [], removed: [] },
      ask: { added: [], removed: [] },
      deny: { added: [], removed: [] },
    },
    hooks: { added: [], removed: [] },
    envKeys: { added: [], removed: [] },
  },
  findings: [],
}))
const settingsPermission = mock(async (_input: unknown) => ({
  revision: 'revision-2',
  counts: { allow: 1, ask: 0, deny: 0 },
  changed: true,
}))
const dashboardMutationAvailable = mock(() => true)
const boardList = mock(async (_input: unknown) => ({ messages: [], warning: null }))
const boardThread = mock(async (_id: string) => ({ root: {}, replies: [] }))
const boardStatus = mock(async (_id: string) => ({ message: {}, receipts: [] }))
const boardPost = mock(async (_input: unknown) => ({ id: '1' }))
const boardReply = mock(async (_input: unknown) => ({ id: '2' }))
const boardAccept = mock(async (_input: unknown) => ({ accepted: '2' }))
const boardWithdraw = mock(async (_id: string) => ({ withdrawn: '1' }))

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
  userDocList,
  userDocGet,
  userDocSet,
  userDocRemove,
  contextGet,
  configSet,
  configList,
  configDelete,
  machineConfigList,
  machineConfigSet,
  machineConfigDelete,
  machinePermissions,
  machinePermission,
  settingsCheck,
  settingsPermission,
  dashboardMutationAvailable,
  boardList,
  boardThread,
  boardStatus,
  boardPost,
  boardReply,
  boardAccept,
  boardWithdraw,
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
  audience: 'technical' as const,
  parent_id: null,
  parent_slug: null,
  position: 0,
  revision: 'revision-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('project.list', () => {
  test('returns the project register rows', async () => {
    const rows = await caller.project.list()

    expect(rows).toHaveLength(9)
    expect(rows[0]).toEqual({
      id: 1,
      name: 'alpha',
      path: '/fixtures/repos/alpha',
      stack: null,
      canon: true,
      repository: true,
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

describe('board router', () => {
  test('each procedure passes its validated input to the board adapter', async () => {
    const uuid = '01990000-0000-7000-8000-000000000968'
    const post = {
      audience: `project:${PLATFORM_SLUG}`,
      title: 'Release notice',
      body: 'Gate before landing.',
      task: 'DEV-968',
      paths: ['hub/**'],
      topics: ['release'],
      ackRequired: true,
      deadline: '30m',
      expires: '1d',
    }

    await caller.board.list({ kind: 'question', open: true, includeEnded: true })
    await caller.board.thread({ id: '1' })
    await caller.board.status({ id: uuid })
    await caller.board.post(post)
    await caller.board.reply({ id: '1', body: 'Acknowledged.' })
    await caller.board.accept({ questionId: uuid, replyId: '2' })
    await caller.board.withdraw({ id: uuid })

    expect(boardList).toHaveBeenLastCalledWith({
      kind: 'question',
      open: true,
      includeEnded: true,
    })
    expect(boardThread).toHaveBeenLastCalledWith('1')
    expect(boardStatus).toHaveBeenLastCalledWith(uuid)
    expect(boardPost).toHaveBeenLastCalledWith(post)
    expect(boardReply).toHaveBeenLastCalledWith({ id: '1', body: 'Acknowledged.' })
    expect(boardAccept).toHaveBeenLastCalledWith({ questionId: uuid, replyId: '2' })
    expect(boardWithdraw).toHaveBeenLastCalledWith(uuid)
  })

  test('rejects malformed ids and empty title or body at the edge', async () => {
    await expect(caller.board.thread({ id: '0' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(
      caller.board.post({ audience: 'operator', title: ' ', body: 'body' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.board.reply({ id: '1', body: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  test('preserves an adapter refusal and remedy', async () => {
    const refusal = 'workers cannot use the architect notice board; rerun from an operator terminal'
    boardPost.mockRejectedValueOnce(new Error(refusal))

    await expect(
      caller.board.post({ audience: 'operator', title: 'Notice', body: 'Body' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: refusal })
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

  test('tree maps local rows to the shared tree contract', async () => {
    docList.mockResolvedValueOnce([{ ...row, id: 7, parent_id: 3 }])
    const result = await caller.doc.tree({ scope: 'global', audience: 'technical' })
    expect(docList).toHaveBeenCalledWith({ scope: 'global', audience: 'technical' })
    expect(result).toEqual({
      items: [
        {
          id: '7',
          slug: 'hello',
          title: 'Hello',
          parentId: '3',
          position: 0,
          updatedAt: '2026-01-01T00:00:00Z',
          scope: 'global',
          subject: null,
          audience: 'technical',
          delivery: 'inject',
          summary: 'Hi',
          featured: false,
        },
      ],
    })
  })

  test('read maps a local row to the shared doc contract', async () => {
    docGet.mockResolvedValueOnce({ ...row, id: 7, parent_id: 3 })
    const result = await caller.doc.read({ scope: 'global', subject: null, slug: 'hello' })
    expect(docGet).toHaveBeenCalledWith('global', null, 'hello')
    expect(result).toEqual({
      id: '7',
      slug: 'hello',
      title: 'Hello',
      parentId: '3',
      position: 0,
      updatedAt: '2026-01-01T00:00:00Z',
      scope: 'global',
      subject: null,
      audience: 'technical',
      delivery: 'inject',
      summary: 'Hi',
      featured: false,
      body: 'Hi',
    })
  })

  test('set passes the input to docSet', async () => {
    const input = {
      scope: 'global' as const,
      subject: null,
      slug: 'hello',
      title: 'Hello',
      body: 'Hi',
      reason: 'updated',
      expectedRevision: 'revision-1',
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
      expectedRevision: 'revision-1',
    })
    expect(docRemove).toHaveBeenCalledWith('global', null, 'hello', 'obsolete', 'revision-1')
    expect(got).toEqual({ removed: true })
  })

  test('set and remove classify stale revision refusals as conflicts', async () => {
    const refusal =
      'orch doc exited 1: refusing stale document update: expected revision revision-1, current revision revision-2'
    const conflict = {
      code: 'CONFLICT',
      message:
        'This document changed since you opened it. Reload to see the current version; your edit was not saved.',
    }
    docSet.mockRejectedValueOnce(new Error(refusal))
    await expect(
      caller.doc.set({
        scope: 'global',
        subject: null,
        slug: 'hello',
        title: 'Hello',
        body: 'Hi',
        reason: 'updated',
        expectedRevision: 'revision-1',
      }),
    ).rejects.toMatchObject(conflict)

    docRemove.mockRejectedValueOnce(new Error(refusal))
    await expect(
      caller.doc.remove({
        scope: 'global',
        subject: null,
        slug: 'hello',
        reason: 'obsolete',
        expectedRevision: 'revision-1',
      }),
    ).rejects.toMatchObject(conflict)
  })

  test('other doc write errors remain bad requests with orch context removed', async () => {
    docSet.mockRejectedValueOnce(new Error('orch doc exited 1: write failed'))
    await expect(
      caller.doc.set({
        scope: 'global',
        subject: null,
        slug: 'hello',
        title: 'Hello',
        body: 'Hi',
        reason: 'updated',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'write failed' })
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
    await expect(
      caller.doc.set({
        scope: 'global',
        subject: null,
        slug: 'hello',
        title: 'Hello',
        body: 'Hi',
        reason: 'updated',
        expectedRevision: ' ',
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
    repository: true,
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

describe('managed context', () => {
  test('returns local autonomy with a warning when hosted config is unavailable', async () => {
    configList.mockRejectedValueOnce(new Error('hosted config is not configured'))

    const result = await caller.context.autonomy.get({ project: 'alpha' })

    expect(result.userPreset).toBeUndefined()
    expect(result.warnings).toContain(
      'warning: hosted autonomy preset and overrides are unavailable until you sign in',
    )
    expect(result.registered && result.stages.every((stage) => stage.overridden === null)).toBe(
      true,
    )
  })

  test('sets the exact hosted user autonomy key and returns a fresh resolution', async () => {
    contextGet.mockResolvedValueOnce({
      registered: true,
      project: 'alpha',
      rulings: { value: 'user', scope: 'built-in' },
      shipTo: { value: 'trunk', scope: 'built-in', landing: 'main', production: null },
      stages: [{ stage: 'review', agreed: true, value: 'review', scope: 'built-in', steps: 1 }],
      text: 'before',
    })
    contextGet.mockResolvedValueOnce({
      registered: true,
      project: 'alpha',
      rulings: { value: 'user', scope: 'hosted user' },
      shipTo: { value: 'trunk', scope: 'built-in', landing: 'main', production: null },
      stages: [{ stage: 'review', agreed: true, value: 'auto', scope: 'hosted user', steps: 1 }],
      text: 'after',
    })
    const result = await caller.context.autonomy.set({
      project: 'alpha',
      stage: 'review',
      value: 'auto',
    })
    expect(configSet).toHaveBeenLastCalledWith('autonomy.stage.review', 'auto')
    expect(contextGet).toHaveBeenLastCalledWith('/fixtures/repos/alpha')
    expect(result.registered && result.stages[0]?.agreed && result.stages[0].scope).toBe(
      'hosted user',
    )
  })

  test('sets the exact hosted user ship-to key', async () => {
    const result = await caller.context.autonomy.setShipTo({
      project: 'alpha',
      value: 'production',
    })
    expect(configSet).toHaveBeenLastCalledWith('autonomy.ship-to', 'production')
    expect(contextGet).toHaveBeenLastCalledWith('/fixtures/repos/alpha')
    expect(result.registered && result.shipTo.value).toBe('trunk')
  })

  test('setting a preset clears user stage overrides and returns the fresh preset', async () => {
    configList
      .mockResolvedValueOnce([
        {
          key: 'autonomy.stage.review',
          environment: 'default',
          scope: 'user',
          value: 'auto',
          rowVersion: 2,
          updatedAt: '2026-09-28T12:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          key: 'autonomy.preset',
          environment: 'default',
          scope: 'user',
          value: 'manual',
          rowVersion: 1,
          updatedAt: '2026-09-28T12:00:01.000Z',
        },
      ])

    const result = await caller.context.autonomy.setPreset({
      project: 'alpha',
      value: 'manual',
    })

    expect(configDelete).toHaveBeenCalledWith('autonomy.stage.review', 2)
    expect(configSet).toHaveBeenCalledWith('autonomy.preset', 'manual', undefined)
    expect(result.userPreset).toBe('manual')
    expect(result.registered && result.stages[0]?.overridden).toBe(false)
  })

  test('a failing preset write deletes no stage overrides', async () => {
    const deletesBefore = configDelete.mock.calls.length
    configSet.mockRejectedValueOnce(new Error('hosted config route returned HTTP 409'))

    await expect(
      caller.context.autonomy.setPreset({
        project: 'alpha',
        value: 'guided',
        expectedRowVersion: 4,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(configSet).toHaveBeenLastCalledWith('autonomy.preset', 'guided', 4)
    expect(configDelete.mock.calls).toHaveLength(deletesBefore)
  })

  test('clears only one hosted stage override and reports an absent override', async () => {
    const entries = [
      {
        key: 'autonomy.preset',
        environment: 'default',
        scope: 'user' as const,
        value: 'guided',
        rowVersion: 1,
        updatedAt: '2026-09-28T12:00:00.000Z',
      },
      {
        key: 'autonomy.stage.review',
        environment: 'default',
        scope: 'user' as const,
        value: 'auto',
        rowVersion: 2,
        updatedAt: '2026-09-28T12:00:00.000Z',
      },
      {
        key: 'autonomy.stage.ship',
        environment: 'default',
        scope: 'user' as const,
        value: 'ask',
        rowVersion: 3,
        updatedAt: '2026-09-28T12:00:00.000Z',
      },
    ]
    configList
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce(entries)

    const result = await caller.context.autonomy.clearStage({
      project: 'alpha',
      stage: 'review',
      expectedRowVersion: 2,
    })

    expect(result.cleared).toBe(true)
    expect(configDelete).toHaveBeenLastCalledWith('autonomy.stage.review', 2)
    expect(configDelete).not.toHaveBeenCalledWith('autonomy.stage.ship', 3)

    configList.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await expect(
      caller.context.autonomy.clearStage({ project: 'alpha', stage: 'review' }),
    ).resolves.toMatchObject({ cleared: false })
  })

  test('writes and removes machine autonomy and reports machine values on reads', async () => {
    machineConfigList.mockResolvedValueOnce([
      { key: 'autonomy.stage.review', value: 'auto', scope: 'local user' },
      { key: 'autonomy.ship-to', value: 'production', scope: 'local user' },
      { key: 'autonomy.rulings', value: 'agent', scope: 'local user' },
    ])
    const read = await caller.context.autonomy.get({ project: 'alpha' })
    expect(read.registered && read.stages[0]?.machineValue).toBe('auto')
    expect(read.registered && read.shipTo.machineValue).toBe('production')
    expect(read.registered && read.rulings.machineValue).toBe('agent')

    machineConfigList.mockResolvedValueOnce([
      { key: 'autonomy.stage.review', value: 'invalid-stage', scope: 'local user' },
      { key: 'autonomy.ship-to', value: 'invalid-ship-to', scope: 'local user' },
      { key: 'autonomy.rulings', value: 'invalid-rulings', scope: 'local user' },
    ])
    const invalidRead = await caller.context.autonomy.get({ project: 'alpha' })
    expect(invalidRead.registered && invalidRead.stages[0]?.machineValue).toBeUndefined()
    expect(invalidRead.registered && invalidRead.shipTo.machineValue).toBeUndefined()
    expect(invalidRead.registered && invalidRead.rulings.machineValue).toBeUndefined()

    machineConfigList.mockResolvedValueOnce([
      { key: 'autonomy.stage.review', value: 'review', scope: 'local user' },
    ])
    await caller.context.autonomy.setMachine({
      project: 'alpha',
      kind: 'stage',
      stage: 'review',
      value: 'review',
    })
    expect(machineConfigSet).toHaveBeenLastCalledWith('autonomy.stage.review', 'review')

    machineConfigList
      .mockResolvedValueOnce([{ key: 'autonomy.ship-to', value: 'trunk', scope: 'local user' }])
      .mockResolvedValueOnce([])
    const cleared = await caller.context.autonomy.clearMachine({
      project: 'alpha',
      kind: 'shipTo',
    })
    expect(machineConfigDelete).toHaveBeenLastCalledWith('autonomy.ship-to')
    expect(cleared.removed).toBe(true)
  })

  test('retries a conflicted preset override delete and reports only overrides left', async () => {
    configList
      .mockResolvedValueOnce([
        {
          key: 'autonomy.stage.review',
          environment: 'default',
          scope: 'user',
          value: 'auto',
          rowVersion: 2,
          updatedAt: '2026-09-28T12:00:00.000Z',
        },
        {
          key: 'autonomy.stage.ship',
          environment: 'default',
          scope: 'user',
          value: 'auto',
          rowVersion: 7,
          updatedAt: '2026-09-28T12:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          key: 'autonomy.stage.review',
          environment: 'default',
          scope: 'user',
          value: 'auto',
          rowVersion: 3,
          updatedAt: '2026-09-28T12:00:01.000Z',
        },
      ])
    configDelete
      .mockRejectedValueOnce(new Error('hosted config route returned HTTP 409'))
      .mockRejectedValueOnce(new Error('hosted config route returned HTTP 409'))

    await expect(
      caller.context.autonomy.setPreset({ project: 'alpha', value: 'manual' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('review'),
    })

    expect(configDelete).toHaveBeenCalledWith('autonomy.stage.review', 2)
    expect(configDelete).toHaveBeenCalledWith('autonomy.stage.review', 3)
    expect(configDelete).toHaveBeenCalledWith('autonomy.stage.ship', 7)
  })

  test('validates permission edits before calling orch', async () => {
    await expect(
      caller.context.settings.permission({
        target: { user: true },
        list: 'allow',
        rule: ' ',
        operation: 'add',
        reason: 'because',
        expectedRevision: 'revision-1',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.context.settings.permission({
        target: { user: true },
        list: 'allow',
        rule: 'Bash(orch *)',
        operation: 'add',
        reason: 'because',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(settingsPermission).not.toHaveBeenCalled()
  })

  test('passes one validated permission edit to orch without an owner id', async () => {
    const input = {
      target: { user: true as const },
      list: 'allow' as const,
      rule: 'Bash(orch *)',
      operation: 'add' as const,
      reason: 'because',
      expectedRevision: 'revision-1',
    }
    await caller.context.settings.permission({
      ...input,
      target: { user: true, owner: 'someone-else' },
    } as never)
    expect(settingsPermission).toHaveBeenLastCalledWith(input)
  })

  test('reports and edits the machine permission overlay', async () => {
    machinePermissions.mockResolvedValueOnce({
      additions: { allow: ['Bash(git status)'], ask: [], deny: [] },
      drop: { allow: [], ask: ['Bash(rm *)'], deny: [] },
    })
    await expect(caller.context.settings.get({ user: true })).resolves.toMatchObject({
      machine: {
        additions: { allow: ['Bash(git status)'] },
        drop: { ask: ['Bash(rm *)'] },
      },
    })
    await caller.context.settings.machinePermission({
      operation: 'drop',
      list: 'ask',
      rule: 'Bash(rm *)',
    })
    expect(machinePermission).toHaveBeenLastCalledWith({
      operation: 'drop',
      list: 'ask',
      rule: 'Bash(rm *)',
    })
  })

  test('maps a missing signed-in record session to a refusal instead of rows', async () => {
    userDocList.mockImplementationOnce(async () => {
      throw new Error('no signed-in record session; cleared by: run `orch record login`')
    })
    await expect(caller.context.userCanon.list()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'no signed-in record session; cleared by: run `orch record login`',
    })
  })

  test('preserves a settings-check refusal verbatim', async () => {
    settingsCheck.mockImplementationOnce(async () => {
      throw new Error('no signed-in record session; run orch record login')
    })
    await expect(caller.context.settings.get({ user: true })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'no signed-in record session; run orch record login',
    })
  })
})
