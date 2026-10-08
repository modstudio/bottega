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
    space: 'alpha',
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
        tasks: trackerTaskOverrides[prefix] ?? [
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
let supportsTargetSpace = true
let refusedTargetSpace: string | null = null
const trackerStatuses: Record<string, string> = { ALP: 'started', STO: 'started' }
const trackerTaskOverrides: Record<string, Array<Record<string, unknown>> | undefined> = {}
const mirrored = new Map<string, string[]>()
const mirroredEvents: Array<{ task_key: string; project_name: string }> = []
const mirroredTargets: string[] = []
mock.module('../task-client.ts', () => ({
  assertTargetSpaceTaskMirror: (identity: {
    capabilities?: { targetSpaceTaskMirror?: boolean }
  }) => {
    if (identity.capabilities?.targetSpaceTaskMirror !== true)
      throw new Error(
        'hosted hub does not advertise target-space task mirror support; deploy the hub server at or after the target-space task mirror change',
      )
  },
  hostedTaskIdentity: async () => {
    if (refuseIdentity) throw new Error('simulated identity refusal')
    return {
      userId: 'user-active',
      activeSpaceId: 'space-active',
      capabilities: { targetSpaceTaskMirror: supportsTargetSpace },
      memberships: [
        { spaceId: 'space-active', slug: 'active' },
        { spaceId: 'space-alpha', slug: 'alpha' },
        { spaceId: 'space-stopal', slug: 'stopal' },
      ],
    }
  },
  hostedSignedInUserId: async () => 'user-active',
  hostedMirrorTasks: async (body: {
    tasks: Array<{ id: string; key: string }>
    statusEvents?: Array<{ task_key: string; project_name: string }>
    targetSpaceId?: string
  }) => {
    if (!body.targetSpaceId) throw new Error('missing target space')
    if (refuseMirror || refusedTargetSpace === body.targetSpaceId)
      throw new Error('simulated hosted refusal')
    mirroredTargets.push(body.targetSpaceId)
    for (const task of body.tasks ?? []) {
      const ids = mirrored.get(task.key) ?? []
      ids.push(task.id)
      mirrored.set(task.key, ids)
    }
    mirroredEvents.push(...(body.statusEvents ?? []))
    return { upserted: (body.tasks ?? []).length, adoptions: [] }
  },
}))

const { db, writeTransaction } = await import('../db.ts')
const { ingestGit } = await import('./git.ts')
const {
  ingestTrackers,
  mirrorPendingTrackerStatusEvents,
  observeTrackerTask,
  pendingTrackerStatusEvents,
} = await import('./trackers.ts')
const { createCollectorMirrorPass } = await import('./collector-mirror.ts')
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
  mirroredTargets.length = 0
  refuseMirror = false
  refuseIdentity = false
  supportsTargetSpace = true
  refusedTargetSpace = null
  trackerStatuses.ALP = 'started'
  trackerStatuses.STO = 'started'
  delete trackerTaskOverrides.ALP
  delete trackerTaskOverrides.STO
})

test('a refused tracker mirror still writes locally and retries the persisted task id', async () => {
  refuseMirror = true
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  const refused = await ingestTrackers()
  const local = db()
    .query<{ record_id: string; title: string }, []>(
      `SELECT record_id,title FROM task WHERE project='alpha' AND key='ALP-1'`,
    )
    .get()!
  expect(refused.find((row) => row.project === 'alpha')?.error).toBe(
    'hosted mirror skipped: alpha: delivery-failed: simulated hosted refusal',
  )
  expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
    'project=alpha reason=delivery-failed: simulated hosted refusal',
  )
  expect(local.title).toBe('Collected task')

  refuseMirror = false
  await ingestTrackers()
  expect(mirrored.get('ALP-1')).toEqual([local.record_id])
  errors.mockRestore()
})

test('git seeding mirrors two project destinations while the active space is a third', async () => {
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
  const stopalId = db()
    .query<{ record_id: string }, []>(
      `SELECT record_id FROM task WHERE project='stopal' AND key='STO-2'`,
    )
    .get()!.record_id
  expect(mirrored.get('STO-2')).toEqual([stopalId, stopalId])
  expect(new Set(mirroredTargets)).toEqual(new Set(['space-alpha', 'space-stopal']))
  expect(mirroredTargets).not.toContain('space-active')
  expect(scanned).toEqual([
    '/fixtures/repos/alpha',
    '/fixtures/repos/stopal',
    '/fixtures/repos/alpha',
    '/fixtures/repos/stopal',
  ])
})

test('a refused first git mirror batch does not stop a later deliverable batch', async () => {
  const originalSpace = project.settings.space
  project.settings.space = 'not-a-membership'
  const outputFor = (stopal: boolean) => {
    const count = stopal ? 1 : 500
    const prefix = stopal ? 'STO' : 'ALP'
    return new TextEncoder().encode(
      Array.from(
        { length: count },
        (_, index) =>
          `\u00002026-09-24\t2026-09-24T12:00:00.000Z\t${prefix.toLowerCase()}-${index}\t${prefix}-${index + 10} collected\n1\t0\tsrc/file-${index}.ts`,
      ).join('\n'),
    )
  }
  const spawn = spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => ({
    stdout: outputFor(command.includes('/fixtures/repos/stopal')),
  })) as typeof Bun.spawnSync)
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await ingestGit('2026-09-01')
  } finally {
    errors.mockRestore()
    spawn.mockRestore()
    project.settings.space = originalSpace
  }

  expect(mirrored.has('ALP-10')).toBeFalse()
  expect(mirrored.has('STO-10')).toBeTrue()
  expect(mirroredTargets).toEqual(['space-stopal'])
})

test('tracker status events follow their task project destinations', async () => {
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
  expect(mirroredEvents.map((event) => event.project_name)).toEqual(['alpha', 'stopal'])
})

test('a fresh transition is mirrored exactly once by the following collect', async () => {
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

  expect(mirroredEvents).toEqual([])
  trackerStatuses.ALP = 'completed'
  await ingestTrackers()
  expect(mirroredEvents).toEqual([
    expect.objectContaining({
      task_key: 'ALP-1',
      project_name: 'alpha',
    }),
  ])
})

test('a collected key change records and mirrors the external-id transition', async () => {
  await ingestTrackers()
  mirroredEvents.length = 0
  trackerTaskOverrides.ALP = [
    {
      id: 'tracker-alp-1',
      short_id: 'ALP-RENAMED',
      summary: 'Collected task',
      status: 'completed',
      status_category: 'completed',
    },
  ]

  const results = await ingestTrackers()

  expect(results.find((result) => result.project === 'alpha')?.changed).toBe(1)
  expect(mirroredEvents).toEqual([
    expect.objectContaining({ task_key: 'ALP-RENAMED', project_name: 'alpha' }),
  ])
})

test('a key arriving twice records and mirrors only its final transition', async () => {
  await ingestTrackers()
  mirroredEvents.length = 0
  trackerTaskOverrides.ALP = [
    {
      id: 'tracker-alp-1',
      short_id: 'ALP-1',
      summary: 'Collected task',
      status: 'started',
      status_category: 'started',
    },
    {
      id: 'tracker-alp-1',
      short_id: 'ALP-1',
      summary: 'Collected task',
      status: 'completed',
      status_category: 'completed',
    },
  ]

  const results = await ingestTrackers()

  expect(results.find((result) => result.project === 'alpha')?.changed).toBe(1)
  expect(mirroredEvents).toEqual([
    expect.objectContaining({ task_key: 'ALP-1', project_name: 'alpha' }),
  ])
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

test('one refused destination leaves the other delivered and reports the project', async () => {
  refusedTargetSpace = 'space-stopal'
  const errors = spyOn(console, 'error').mockImplementation(() => {})

  const result = await ingestTrackers()

  expect(db().query(`SELECT 1 FROM task WHERE key='ALP-1'`).get()).toBeTruthy()
  expect(db().query(`SELECT 1 FROM task WHERE key='STO-1'`).get()).toBeTruthy()
  expect(mirrored.has('ALP-1')).toBeTrue()
  expect(mirrored.has('STO-1')).toBeFalse()
  expect(result.find((row) => row.project === 'alpha')?.error).toBeUndefined()
  expect(result.find((row) => row.project === 'stopal')?.error).toBe(
    'hosted mirror skipped: stopal: delivery-failed: simulated hosted refusal',
  )
  expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
    'project=stopal reason=delivery-failed: simulated hosted refusal',
  )
  errors.mockRestore()
})

test('failed destination status events remain pending while delivered events are removed', async () => {
  await ingestTrackers()
  const transitioned = (name: 'alpha' | 'stopal', prefix: 'ALP' | 'STO') => ({
    externalId: `tracker-${prefix.toLowerCase()}-1`,
    key: `${prefix}-1`,
    project: name,
    title: 'Collected task',
    status: 'completed',
    category: 'done' as const,
    updatedAt: null,
    assignee: null,
  })
  observeTrackerTask(transitioned('alpha', 'ALP'), '2026-10-08T12:00:00.000Z', true)
  observeTrackerTask(transitioned('stopal', 'STO'), '2026-10-08T12:00:00.000Z', true)
  refusedTargetSpace = 'space-stopal'
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  const mirror = await createCollectorMirrorPass('tracker')

  expect(await mirrorPendingTrackerStatusEvents(mirror, 'alpha')).toBeNull()
  expect((await mirrorPendingTrackerStatusEvents(mirror, 'stopal'))?.message).toContain(
    'stopal: delivery-failed: simulated hosted refusal',
  )

  expect(pendingTrackerStatusEvents().map((entry) => entry.project)).toEqual(['stopal'])
  expect(mirroredEvents.map((entry) => entry.project_name)).toEqual(['alpha'])
  errors.mockRestore()
})

test('a server without target-space support refuses the collector before its first write', async () => {
  supportsTargetSpace = false
  const errors = spyOn(console, 'error').mockImplementation(() => {})

  const result = await ingestTrackers()

  expect(mirroredTargets).toEqual([])
  expect(result.find((row) => row.project === 'alpha')?.error).toContain(
    'does not advertise target-space task mirror support',
  )
  expect(result.find((row) => row.project === 'alpha')?.error).toContain(
    'deploy the hub server at or after the target-space task mirror change',
  )
  errors.mockRestore()
})
