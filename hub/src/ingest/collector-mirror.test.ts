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
  failureDetail: (error: unknown) => String(error),
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
let refuseTaskMirror = false
let refuseStatusEventMirror = false
let refuseStatusEventMirrorCall: number | null = null
let refuseIdentity = false
let supportsTargetSpace = true
let refusedTargetSpace: string | null = null
const trackerStatuses: Record<string, string> = { ALP: 'started', STO: 'started' }
const trackerTaskOverrides: Record<string, Array<Record<string, unknown>> | undefined> = {}
const mirrored = new Map<string, string[]>()
const mirroredTaskRows: Array<Record<string, unknown>> = []
const mirroredEvents: Array<{ task_key: string; project_name: string; at?: string }> = []
const statusEventMirrorBatchSizes: number[] = []
const mirroredTargets: string[] = []
mock.module('../task-client.ts', () => ({
  assertProjectNoteCounters: () => {},
  assertDayRecordId: () => {},
  assertIntervalRecordId: () => {},
  assertTargetSpaceIntervalEvidence: () => {},
  assertTargetSpaceNotes: () => {},
  assertTargetSpaceTaskMirror: (identity: {
    capabilities?: { targetSpaceTaskMirror?: boolean }
  }) => {
    if (identity.capabilities?.targetSpaceTaskMirror !== true)
      throw new Error(
        'hosted hub does not advertise target-space task mirror support; deploy the hub server at or after the target-space task mirror change',
      )
  },
  hostedCloseTask: async () => null,
  hostedCommentTask: async () => null,
  hostedCreateDocument: async () => null,
  hostedCreateOperatorWaitingEmail: async () => null,
  hostedCreateTask: async () => null,
  hostedDeleteDocument: async () => null,
  hostedDeleteTasks: async () => null,
  hostedListTasks: async () => [],
  hostedPatchDocument: async () => null,
  hostedPatchTask: async () => null,
  hostedTaskChanges: async () => null,
  hostedTaskCounts: async () => null,
  hostedTaskPresence: async () => null,
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
  hostedSpaceChanges: async () => null,
  hostedMirrorTasks: async (
    body: {
      tasks: Array<Record<string, unknown> & { id: string; key: string }>
      statusEvents?: Array<{ task_key: string; project_name: string }>
    },
    options?: { recordSpace?: string | null },
  ) => {
    if (!options?.recordSpace) throw new Error('missing target space')
    const statusEventCount = body.statusEvents?.length ?? 0
    if (body.tasks.length + statusEventCount > 500)
      throw new Error('mirror accepts at most 500 rows')
    if (statusEventCount > 0) statusEventMirrorBatchSizes.push(statusEventCount)
    if (
      refuseMirror ||
      (refuseTaskMirror && body.tasks.length > 0) ||
      (refuseStatusEventMirror && statusEventCount > 0) ||
      (statusEventCount > 0 &&
        refuseStatusEventMirrorCall === statusEventMirrorBatchSizes.length) ||
      refusedTargetSpace === options.recordSpace
    )
      throw new Error('simulated hosted refusal')
    mirroredTargets.push(options.recordSpace)
    for (const task of body.tasks ?? []) {
      mirroredTaskRows.push(task)
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
  mirroredTaskRows.length = 0
  mirroredEvents.length = 0
  statusEventMirrorBatchSizes.length = 0
  mirroredTargets.length = 0
  refuseMirror = false
  refuseTaskMirror = false
  refuseStatusEventMirror = false
  refuseStatusEventMirrorCall = null
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
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO day (record_id,day,collected_at) VALUES (?,?,?)`)
      .run('11111111-1111-4111-8111-111111111111', '2026-09-24', '2026-09-24T00:00:00.000Z'),
  )
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
  expect(
    db().query<{ record_id: string }, []>(`SELECT record_id FROM day WHERE day='2026-09-24'`).get(),
  ).toEqual({ record_id: '11111111-1111-4111-8111-111111111111' })
  expect(new Set(mirroredTargets)).toEqual(new Set(['space-alpha', 'space-stopal']))
  expect(mirroredTargets).not.toContain('space-active')
  expect(scanned).toEqual([
    '/fixtures/repos/alpha',
    '/fixtures/repos/stopal',
    '/fixtures/repos/alpha',
    '/fixtures/repos/stopal',
  ])
})

function gitTaskLog(key: string, dates: string[]) {
  return new TextEncoder().encode(
    dates
      .map(
        (date, index) =>
          `\u0000${date}\t${date}T12:00:00.000Z\t${key.toLowerCase()}-${date}-${index}\t${key} collected\n1\t0\tsrc/file.ts`,
      )
      .join('\n'),
  )
}

function mockGitTaskScans(key: string, scans: string[][]) {
  let scan = 0
  return spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    if (command.includes('/fixtures/repos/stopal'))
      return { stdout: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
    return { stdout: gitTaskLog(key, scans[scan++] ?? []) } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync)
}

test('a narrower git scan preserves and mirrors the earlier opening date', async () => {
  const spawn = mockGitTaskScans('ALP-20', [['2026-06-30', '2026-10-03'], ['2026-10-03']])
  try {
    await ingestGit('2026-06-01')
    await ingestGit('2026-10-01')
  } finally {
    spawn.mockRestore()
  }

  expect(
    db().query<{ opened_at: string }, []>(`SELECT opened_at FROM task WHERE key='ALP-20'`).get(),
  ).toEqual({ opened_at: '2026-06-30' })
  expect(
    mirroredTaskRows.filter((row) => row.key === 'ALP-20').map((row) => row.opened_at),
  ).toEqual(['2026-06-30', '2026-06-30'])
})

test('a wider git scan moves the opening date earlier once and mirrors it', async () => {
  const spawn = mockGitTaskScans('ALP-21', [['2026-10-03'], ['2026-06-30', '2026-10-03']])
  try {
    await ingestGit('2026-10-01')
    await ingestGit('2026-06-01')
  } finally {
    spawn.mockRestore()
  }

  expect(
    db().query<{ opened_at: string }, []>(`SELECT opened_at FROM task WHERE key='ALP-21'`).get(),
  ).toEqual({ opened_at: '2026-06-30' })
  expect(
    mirroredTaskRows.filter((row) => row.key === 'ALP-21').map((row) => row.opened_at),
  ).toEqual(['2026-10-03', '2026-06-30'])
})

test('a git mirror sends the complete stored task row', async () => {
  const spawn = mockGitTaskScans('ALP-22', [['2026-09-15', '2026-10-03']])
  try {
    await ingestGit('2026-09-01')
  } finally {
    spawn.mockRestore()
  }

  const stored = db()
    .query<Record<string, unknown>, []>(`SELECT * FROM task WHERE key='ALP-22'`)
    .get()!
  const sent = mirroredTaskRows.find((row) => row.key === 'ALP-22')!
  expect(sent).toEqual({
    id: stored.record_id,
    key: stored.key,
    project: stored.project,
    project_name: stored.project,
    title: stored.title,
    status: stored.status,
    status_category: stored.status_category,
    parent_key: stored.parent_key,
    body: stored.body,
    assignee: stored.assignee,
    opened_at: stored.opened_at,
    closed_at: stored.closed_at,
    source: stored.source,
    first_seen: stored.first_seen,
    last_seen: stored.last_seen,
    created_at: stored.first_seen,
    updated_at: stored.updated_at,
    deleted_at: null,
    next_document_number: stored.next_document_number,
  })
})

test('git ingestion preserves tracker fields while refreshing its timestamps', async () => {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO task
          (record_id,key,project,title,status,status_category,opened_at,closed_at,updated_at,
           source,first_seen,last_seen,next_document_number)
         VALUES (?,?,?,?,?,?,?,?,?,'mcp',?,?,?)`,
      )
      .run(
        '22222222-2222-4222-8222-222222222222',
        'ALP-23',
        'alpha',
        'Tracker task',
        'started',
        'active',
        '2026-01-02T03:04:05.000Z',
        null,
        '2026-02-03T04:05:06.000Z',
        '2026-01-02T03:04:05.000Z',
        '2026-02-03T04:05:06.000Z',
        7,
      ),
  )
  const spawn = mockGitTaskScans('ALP-23', [['2025-12-01', '2026-10-03']])
  try {
    await ingestGit('2025-12-01')
  } finally {
    spawn.mockRestore()
  }

  expect(db().query(`SELECT * FROM task WHERE key='ALP-23'`).get()).toEqual(
    expect.objectContaining({
      record_id: '22222222-2222-4222-8222-222222222222',
      title: 'Tracker task',
      status: 'started',
      status_category: 'active',
      opened_at: '2026-01-02T03:04:05.000Z',
      updated_at: '2026-10-03',
      source: 'mcp',
      first_seen: '2026-01-02T03:04:05.000Z',
      next_document_number: 7,
    }),
  )
  expect(mirroredTaskRows.find((row) => row.key === 'ALP-23')).toEqual(
    expect.objectContaining({ source: 'git', opened_at: '2025-12-01' }),
  )
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

test('a refused collected transition is delivered by a later unchanged collection pass', async () => {
  await ingestTrackers()
  trackerStatuses.ALP = 'completed'
  refuseStatusEventMirror = true

  const refused = await ingestTrackers()

  expect(refused.find((result) => result.project === 'alpha')?.error).toBe(
    'hosted mirror skipped: alpha: delivery-failed: simulated hosted refusal',
  )
  expect(mirroredEvents).toEqual([])
  expect(pendingTrackerStatusEvents()).toEqual([
    expect.objectContaining({ project: 'alpha', key: 'ALP-1' }),
  ])

  refuseStatusEventMirror = false
  const recovered = await ingestTrackers()

  expect(recovered.every((result) => result.changed === 0)).toBeTrue()
  expect(mirroredEvents.map((event) => event.task_key)).toEqual(['ALP-1'])
  expect(pendingTrackerStatusEvents()).toEqual([])
})

test('a delivered collected transition is sent exactly once across two passes', async () => {
  await ingestTrackers()
  trackerStatuses.ALP = 'completed'

  await ingestTrackers()
  await ingestTrackers()

  expect(mirroredEvents.filter((event) => event.task_key === 'ALP-1')).toHaveLength(1)
  expect(pendingTrackerStatusEvents()).toEqual([])
})

test('a failed task mirror leaves its collected transition queued', async () => {
  await ingestTrackers()
  trackerStatuses.ALP = 'completed'
  refuseTaskMirror = true

  const failed = await ingestTrackers()

  expect(failed.find((result) => result.project === 'alpha')?.error).toBe(
    'hosted mirror skipped: alpha: delivery-failed: simulated hosted refusal',
  )
  expect(mirroredEvents).toEqual([])
  expect(pendingTrackerStatusEvents().map((event) => event.key)).toEqual(['ALP-1'])

  refuseTaskMirror = false
  await ingestTrackers()
  expect(mirroredEvents.map((event) => event.task_key)).toEqual(['ALP-1'])
  expect(pendingTrackerStatusEvents()).toEqual([])
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

test('pending status events are mirrored oldest first in delivered slices of 500', async () => {
  const task = (category: 'active' | 'done') => ({
    externalId: 'tracker-alp-batched',
    key: 'ALP-500',
    project: 'alpha' as const,
    title: 'Batched task',
    status: category,
    category,
    updatedAt: null,
    assignee: null,
  })
  observeTrackerTask(task('active'), '2026-10-01T00:00:00.000Z')
  for (let index = 1; index <= 501; index += 1) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, 502 - index)).toISOString()
    observeTrackerTask(task(index % 2 === 0 ? 'active' : 'done'), at, true)
  }
  const mirror = await createCollectorMirrorPass('tracker')

  expect(await mirrorPendingTrackerStatusEvents(mirror, 'alpha', Date.UTC(2026, 9, 2))).toBeNull()
  expect(statusEventMirrorBatchSizes).toEqual([500, 1])
  expect(mirroredEvents).toHaveLength(501)
  expect(mirroredEvents[0]?.at).toBe('2026-10-01T00:00:00.001Z')
  expect(mirroredEvents[500]?.at).toBe('2026-10-01T00:00:00.501Z')
  expect(pendingTrackerStatusEvents()).toEqual([])

  mirroredEvents.length = 0
  statusEventMirrorBatchSizes.length = 0
  for (let index = 502; index <= 1002; index += 1) {
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, 1504 - index)).toISOString()
    observeTrackerTask(task(index % 2 === 0 ? 'active' : 'done'), at, true)
  }
  refuseStatusEventMirrorCall = 2

  expect(
    (await mirrorPendingTrackerStatusEvents(mirror, 'alpha', Date.UTC(2026, 9, 2)))?.message,
  ).toContain('simulated hosted refusal')
  expect(statusEventMirrorBatchSizes).toEqual([500, 1])
  expect(mirroredEvents).toHaveLength(500)
  expect(pendingTrackerStatusEvents()).toHaveLength(1)
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
