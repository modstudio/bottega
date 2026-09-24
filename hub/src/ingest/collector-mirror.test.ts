import { beforeEach, expect, mock, spyOn, test } from 'bun:test'

const project = {
  id: 1,
  name: 'alpha',
  path: '/fixtures/repos/alpha',
  stack: null,
  canon: true,
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

mock.module('../projects.ts', () => ({
  projects: () => [project],
  projectRoot: () => '/fixtures/repos',
  projectNames: () => ['alpha'],
  refreshProjects: () => {},
}))

mock.module('../mcp.ts', () => ({
  credentials: async () => ({ url: 'https://tracker.example.test', token: 'tracker-token' }),
  Mcp: class {
    async initialize() {}
    async callTool() {
      return {
        tasks: [
          {
            id: 'tracker-alp-1',
            short_id: 'ALP-1',
            summary: 'Collected task',
            status: 'started',
            status_category: 'started',
          },
        ],
        last_page: 1,
      }
    }
  },
}))

let refuseMirror = false
const mirrored = new Map<string, string[]>()
mock.module('../task-client.ts', () => ({
  hostedMirrorTasks: async (body: { tasks: Array<{ id: string; key: string }> }) => {
    for (const task of body.tasks) {
      const ids = mirrored.get(task.key) ?? []
      ids.push(task.id)
      mirrored.set(task.key, ids)
    }
    if (refuseMirror) throw new Error('simulated hosted refusal')
    return { upserted: body.tasks.length, adoptions: [] }
  },
}))

const { db, writeTransaction } = await import('../db.ts')
const { ingestGit } = await import('./git.ts')
const { ingestTrackers } = await import('./trackers.ts')

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
  refuseMirror = false
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

test('git seeding mirrors its persisted task id across two passes', async () => {
  const output = new TextEncoder().encode(
    '\u00002026-09-24\t2026-09-24T12:00:00.000Z\tdeadbeef\tALP-2 collected\n1\t0\tsrc/file.ts\n',
  )
  const spawn = spyOn(Bun, 'spawnSync').mockReturnValue({ stdout: output } as ReturnType<
    typeof Bun.spawnSync
  >)
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
})
