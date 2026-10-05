import { beforeEach, expect, mock, spyOn, test } from 'bun:test'

const project = {
  id: 1,
  name: 'alpha',
  path: '/fixtures/repos/alpha',
  stack: null,
  canon: true,
  repository: true,
  settings: {
    keyPrefixes: ['ALP'],
    tracker: {
      protocol: 'workspace-mcp' as const,
      envPrefix: 'ALPHA',
      openStatuses: ['started'],
      states: { started: 'active' as const },
    },
  },
}
const stopalProject = {
  ...project,
  id: 2,
  name: 'stopal',
  path: '/fixtures/repos/stopal',
  settings: {
    ...project.settings,
    keyPrefixes: ['STO'],
    space: 'stopal',
    tracker: { ...project.settings.tracker, envPrefix: 'STOPAL' },
  },
}
const localTasksProject = {
  ...project,
  id: 3,
  name: 'tasks',
  path: '/fixtures/state/projects/tasks',
  canon: false,
  repository: false,
  settings: { keyPrefixes: ['TASK'] },
}

mock.module('../projects.ts', () => ({
  projects: () => [project, stopalProject, localTasksProject],
  projectRoot: () => '/fixtures/repos',
  projectNames: () => ['alpha'],
  refreshProjects: () => {},
}))

mock.module('../mcp.ts', () => ({
  credentials: async (prefix: string) => ({
    url: `https://${prefix.toLowerCase()}.example.test`,
    token: 'tracker-token',
  }),
  Mcp: class {
    private url: string
    constructor(url: string) {
      this.url = url
    }
    async initialize() {}
    async close() {}
    async callTool() {
      const stopal = this.url.includes('stopal')
      const prefix = stopal ? 'STO' : 'ALP'
      const status = trackerStatuses[prefix] ?? 'started'
      return {
        tasks: [
          {
            id: `tracker-${prefix.toLowerCase()}-1`,
            short_id: `${prefix}-1`,
            summary: 'Collected task',
            status,
            status_category: status,
          },
        ],
        last_page: 1,
      }
    }
  },
}))

let refuseMirror = false
let refuseIdentity = false
let changeActiveSpace = false
const trackerStatuses: Record<string, string> = { ALP: 'started', STO: 'started' }
const mirrored = new Map<string, string[]>()
const mirroredEvents: Array<{ task_key: string; project_name: string }> = []
mock.module('../task-client.ts', () => ({
  hostedTaskIdentity: async () => {
    if (refuseIdentity) throw new Error('simulated identity refusal')
    return {
      userId: 'user-active',
      activeSpaceId: 'space-active',
      memberships: [
        { spaceId: 'space-active', slug: 'active' },
        { spaceId: 'space-stopal', slug: 'stopal' },
      ],
    }
  },
  hostedMirrorTasks: async (body: {
    tasks: Array<{ id: string; key: string }>
    statusEvents?: Array<{ task_key: string; project_name: string }>
    expectedSpaceId?: string
  }) => {
    if (changeActiveSpace)
      throw new Error(
        `hosted hub refused the request (409): mirror expected space ${body.expectedSpaceId}, actual space space-changed; re-run after the active space settles`,
      )
    if (body.expectedSpaceId !== 'space-active') throw new Error('missing expected active space')
    for (const task of body.tasks ?? []) {
      const ids = mirrored.get(task.key) ?? []
      ids.push(task.id)
      mirrored.set(task.key, ids)
    }
    mirroredEvents.push(...(body.statusEvents ?? []))
    if (refuseMirror) throw new Error('simulated hosted refusal')
    return { upserted: (body.tasks ?? []).length, adoptions: [] }
  },
}))

const { db, writeTransaction } = await import('../db.ts')
const { ingestGit } = await import('./git.ts')
const { ingestTrackers } = await import('./trackers.ts')
const { refreshTrackerTask } = await import('../tracker-task-cli.ts')

beforeEach(() => {
  writeTransaction((conn) => {
    for (const table of [
      'task_comment',
      'task_document',
      'task_status_event',
      'note',
      'commit_key',
      'interval',
      'task_identity_claim',
      'task_identity_migration_repairs',
      'task',
      'day',
      'setting',
    ])
      conn.exec(`DELETE FROM ${table}`)
  })
  mirrored.clear()
  mirroredEvents.length = 0
  refuseMirror = false
  refuseIdentity = false
  changeActiveSpace = false
  trackerStatuses.ALP = 'started'
  trackerStatuses.STO = 'started'
})

test('a refused tracker mirror still writes locally and retries the persisted task id', async () => {
  refuseMirror = true
  const refused = await ingestTrackers()
  const local = db()
    .query<{ record_id: string; title: string }, []>(
      `SELECT record_id,title FROM task WHERE project='alpha' AND key='ALP-1'`,
    )
    .get()!
  expect(refused[0]).toMatchObject({
    project: 'alpha',
    tasks: 1,
    error: 'hosted mirror skipped: simulated hosted refusal',
  })
  expect(local.title).toBe('Collected task')

  refuseMirror = false
  await ingestTrackers()
  expect(mirrored.get('ALP-1')).toEqual([local.record_id, local.record_id])
})

test('git seeding keeps a foreign-space task local and mirrors only the active-space task', async () => {
  const scanned: string[] = []
  const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    scanned.push(command[2]!)
    const stopal = command.includes('/fixtures/repos/stopal')
    const key = stopal ? 'STO-2' : 'ALP-2'
    const sha = stopal ? 'feedface' : 'deadbeef'
    const output = new TextEncoder().encode(
      `\u00002026-09-24\t2026-09-24T12:00:00.000Z\t${sha}\t${key} collected\n1\t0\tsrc/file.ts\n`,
    )
    return { stdout: output } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync)
  try {
    await ingestGit('2026-09-01')
    await ingestGit('2026-09-01')
  } finally {
    spawn.mockRestore()
  }

  const localId = db()
    .query<{ record_id: string }, []>(
      `SELECT record_id FROM task WHERE project='alpha' AND key='ALP-2'`,
    )
    .get()!.record_id
  expect(mirrored.get('ALP-2')).toEqual([localId, localId])
  expect(
    db().query<{ project: string }, []>(`SELECT project FROM task WHERE key='STO-2'`).get()
      ?.project,
  ).toBe('stopal')
  expect(mirrored.has('STO-2')).toBe(false)
  expect(scanned).toEqual([
    '/fixtures/repos/alpha',
    '/fixtures/repos/stopal',
    '/fixtures/repos/alpha',
    '/fixtures/repos/stopal',
  ])
})

test('tracker status events use the same project-space filter as task snapshots', async () => {
  await ingestTrackers()
  trackerStatuses.ALP = 'completed'
  trackerStatuses.STO = 'completed'
  await ingestTrackers()

  expect(
    db()
      .query<{ project: string; count: number }, []>(
        `SELECT t.project,count(*) count FROM task_status_event e
         JOIN task t ON t.record_id=e.task_record_id GROUP BY t.project ORDER BY t.project`,
      )
      .all(),
  ).toEqual([
    { project: 'alpha', count: 1 },
    { project: 'stopal', count: 1 },
  ])
  expect(mirroredEvents.map((event) => event.project_name)).toEqual(['alpha'])
})

test('a transition mirrored by a fresh read is not mirrored again by the following collect', async () => {
  await ingestTrackers()

  await refreshTrackerTask('ALP-1', 'alpha', {
    registeredProjects: () => [project],
    sourceFor: () => ({
      project: 'alpha',
      env: 'ALPHA',
      fetch: async () => [],
      lookup: async () => ({
        externalId: 'tracker-alp-1',
        key: 'ALP-1',
        project: 'alpha',
        title: 'Collected task',
        status: 'completed',
        category: 'open',
        updatedAt: null,
        assignee: null,
      }),
    }),
    readCredentials: async () => ({ url: 'https://alpha.example.test', token: 'tracker-token' }),
    connect: async () => ({
      callTool: async () => ({}),
      close: async () => {},
    }),
  })

  expect(mirroredEvents).toEqual([
    expect.objectContaining({
      task_key: 'ALP-1',
      project_name: 'alpha',
    }),
  ])
  trackerStatuses.ALP = 'completed'
  await ingestTrackers()
  expect(mirroredEvents).toHaveLength(1)
})

test('an unreadable identity keeps collected tasks local and performs no hosted writes', async () => {
  refuseIdentity = true
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  const output = new TextEncoder().encode(
    '\u00002026-09-24\t2026-09-24T12:00:00.000Z\tdeadbeef\tALP-3 collected\n1\t0\tsrc/file.ts\n',
  )
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({ stdout: output } as ReturnType<
    typeof Bun.spawnSync
  >)
  try {
    await ingestGit('2026-09-01')
  } finally {
    spawn.mockRestore()
  }

  expect(db().query(`SELECT 1 FROM task WHERE key='ALP-3'`).get()).toBeTruthy()
  expect(mirrored.size).toBe(0)
  expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
    'reason=identity-unreadable',
  )
  errors.mockRestore()
})

test('an active-space change keeps collected tasks local and skips the rest of the pass', async () => {
  changeActiveSpace = true
  const errors = spyOn(console, 'error').mockImplementation(() => {})

  const result = await ingestTrackers()

  expect(db().query(`SELECT 1 FROM task WHERE key='ALP-1'`).get()).toBeTruthy()
  expect(db().query(`SELECT 1 FROM task WHERE key='STO-1'`).get()).toBeTruthy()
  expect(mirrored.size).toBe(0)
  expect(result.every((row) => row.error === undefined)).toBeTrue()
  expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
    'reason=identity-unreadable',
  )
  expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
    're-run after the active space settles',
  )
  errors.mockRestore()
})
