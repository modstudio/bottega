import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planRefGuardMigration } from '../resources/ref-guard.ts'
import { planRetainedRefMigration } from '../resources/resource-inventory.ts'
import { planRunArtifactMigration } from '../run/run-artifacts.ts'
import { planCoordinatorLogMigration } from '../run/run-coordinator-log.ts'
import { planRunLeaseMigration } from '../run/run-lease.ts'
import { planWorktreeMarkerMigration } from '../worktree/worktree-attribution.ts'
import {
  applyRunFilesystemIdentityMigration,
  discoverRunFilesystemIdentityMigration,
  liveRunFilesystemMigrationRefusal,
} from './run-filesystem-identity.ts'

const roots: string[] = []
let repositoryTemplate = ''

beforeAll(() => {
  repositoryTemplate = mkdtempSync(join(tmpdir(), 'run-filesystem-identity-repository-'))
  writeFileSync(join(repositoryTemplate, 'tracked'), 'fixture')
  for (const args of [
    ['init'],
    ['add', 'tracked'],
    ['commit', '-m', 'fixture'],
    ['update-ref', 'refs/orch/retained/7', 'HEAD'],
    ['update-ref', 'refs/orch/retained/88', 'HEAD'],
  ]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: repositoryTemplate, stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    if (args[0] === 'init')
      appendFileSync(
        join(repositoryTemplate, '.git', 'config'),
        '\n[user]\n\tname = Fixture\n\temail = fixture@example.com\n',
      )
  }
  mkdirSync(join(repositoryTemplate, '.git', 'orch-guards', '7'), { recursive: true })
  mkdirSync(join(repositoryTemplate, '.git', 'orch-guards', '88'), { recursive: true })
})

afterAll(() => {
  rmSync(repositoryTemplate, { recursive: true, force: true })
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'run-filesystem-identity-'))
  roots.push(root)
  const runs = join(root, 'runs')
  const tree = join(root, 'tree')
  const project = join(root, 'project')
  mkdirSync(join(runs, '7'), { recursive: true })
  mkdirSync(join(runs, '99'), { recursive: true })
  mkdirSync(join(runs, 'leases'), { recursive: true })
  mkdirSync(tree)
  cpSync(repositoryTemplate, project, { recursive: true })
  writeFileSync(join(runs, '7', 'prompt.txt'), 'kept')
  writeFileSync(join(runs, 'leases', '7.lock'), '')
  writeFileSync(join(runs, 'leases', '88.lock'), '')
  writeFileSync(join(runs, '7.coordinator.log'), 'coordinator')
  writeFileSync(join(tree, '.orch-run'), `7\n${project}\nsource: git\n`)
  const database = new Database(':memory:')
  database.run(
    'CREATE TABLE run (id INTEGER PRIMARY KEY, record_id TEXT NOT NULL, worktree TEXT, status TEXT NOT NULL, project_record_id TEXT)',
  )
  database.run(
    'CREATE TABLE project (record_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, retired_at TEXT)',
  )
  database
    .query('INSERT INTO project(record_id,name,path,retired_at) VALUES (?,?,?,NULL)')
    .run('project-record', 'fixture-project', project)
  database
    .query('INSERT INTO run (id,record_id,worktree,status,project_record_id) VALUES (?,?,?,?,?)')
    .run(7, '77777777-7777-4777-8777-777777777777', tree, 'ok', 'project-record')
  return { database, project, root, runs, tree }
}

test('renames numeric folders, rewrites numeric markers, reports unknowns, and reruns idempotently', () => {
  const { database, project, runs, tree } = fixture()
  expect(
    applyRunFilesystemIdentityMigration(discoverRunFilesystemIdentityMigration(database, runs)),
  ).toEqual({
    foldersRenamed: 1,
    markersWritten: 1,
    leaseFilesRenamed: 1,
    retainedRefsRenamed: 1,
    refGuardsRenamed: 1,
    coordinatorLogsMoved: 1,
    leftAndReported: [
      `${join(runs, '99')}: no run 99`,
      `${join(runs, 'leases', '88.lock')}: no run 88`,
      `${project}:refs/orch/retained/88: no run 88`,
      `${join(realpathSync(project), '.git', 'orch-guards', '88')}: no run 88`,
    ],
  })
  expect(
    readFileSync(join(runs, '77777777-7777-4777-8777-777777777777', 'prompt.txt'), 'utf8'),
  ).toBe('kept')
  expect(readFileSync(join(tree, '.orch-run'), 'utf8')).toStartWith(
    '77777777-7777-4777-8777-777777777777\n',
  )
  expect(
    readFileSync(join(runs, '77777777-7777-4777-8777-777777777777', 'coordinator.log'), 'utf8'),
  ).toBe('coordinator')
  expect(
    readFileSync(join(runs, 'leases', '77777777-7777-4777-8777-777777777777.lock'), 'utf8'),
  ).toBe('')
  const retainedRefs = Bun.spawnSync(
    ['git', 'for-each-ref', '--format=%(refname)', 'refs/orch/retained'],
    { cwd: project },
  ).stdout.toString()
  expect(retainedRefs).toContain('refs/orch/retained/77777777-7777-4777-8777-777777777777')
  expect(retainedRefs).not.toContain('refs/orch/retained/7\n')
  expect(
    existsSync(join(project, '.git', 'orch-guards', '77777777-7777-4777-8777-777777777777')),
  ).toBeTrue()
  expect(
    applyRunFilesystemIdentityMigration(discoverRunFilesystemIdentityMigration(database, runs)),
  ).toEqual({
    foldersRenamed: 0,
    markersWritten: 0,
    leaseFilesRenamed: 0,
    retainedRefsRenamed: 0,
    refGuardsRenamed: 0,
    coordinatorLogsMoved: 0,
    leftAndReported: [
      `${join(runs, '99')}: no run 99`,
      `${join(runs, 'leases', '88.lock')}: no run 88`,
      `${project}:refs/orch/retained/88: no run 88`,
      `${join(realpathSync(project), '.git', 'orch-guards', '88')}: no run 88`,
    ],
  })
})

test('resumes a retained-ref conversion after the UUID ref was created', () => {
  const { database, project, runs } = fixture()
  const uuidRef = 'refs/orch/retained/77777777-7777-4777-8777-777777777777'
  const numericPath = join(project, '.git', 'refs', 'orch', 'retained', '7')
  const uuidPath = join(project, '.git', uuidRef)
  copyFileSync(numericPath, uuidPath)

  expect(
    applyRunFilesystemIdentityMigration(discoverRunFilesystemIdentityMigration(database, runs))
      .retainedRefsRenamed,
  ).toBe(1)
  expect(existsSync(numericPath)).toBeFalse()
  expect(readFileSync(uuidPath, 'utf8')).toMatch(/^[0-9a-f]{40}\n$/)
})

test('refuses before touching files while a run is live', () => {
  const { database, runs } = fixture()
  database.run("UPDATE run SET status='asking' WHERE id=7")
  expect(liveRunFilesystemMigrationRefusal(database)).toContain('wait for it to finish or stop it')
  const plans = discoverRunFilesystemIdentityMigration(database, runs)
  expect(() => {
    const refusal = liveRunFilesystemMigrationRefusal(database)
    if (refusal) throw new Error(refusal)
    applyRunFilesystemIdentityMigration(plans)
  }).toThrow('run 7 is live')
  expect(readFileSync(join(runs, '7', 'prompt.txt'), 'utf8')).toBe('kept')
})

test('each protocol owner purely classifies mapped, collision, and unmapped legacy items', () => {
  const run = {
    number: '7',
    recordId: '77777777-7777-4777-8777-777777777777',
    projectPath: '/repo',
  }
  const runs = new Map([['7', run]])
  const shapes = [
    planRunArtifactMigration(
      '/runs',
      [
        { name: '7', directory: true, destinationExists: false },
        { name: 'sandbox-7', directory: true, destinationExists: true },
        { name: '8', directory: true, destinationExists: false },
      ],
      runs,
    ),
    planCoordinatorLogMigration(
      '/runs',
      [
        { name: '7.coordinator.log', destinationExists: false },
        { name: '7.coordinator.log', destinationExists: true },
        { name: '8.coordinator.log', destinationExists: false },
      ],
      runs,
    ),
    planRunLeaseMigration(
      '/runs/leases',
      [
        { name: '7.lock', destinationExists: false },
        { name: '7.lock', destinationExists: true },
        { name: '8.lock', destinationExists: false },
      ],
      runs,
    ),
    planRetainedRefMigration(
      [
        { projectPath: '/repo', ref: 'refs/orch/retained/7', tip: 'abc', destinationTip: null },
        { projectPath: '/repo', ref: 'refs/orch/retained/7', tip: 'abc', destinationTip: 'def' },
        { projectPath: '/repo', ref: 'refs/orch/retained/8', tip: 'abc', destinationTip: null },
      ],
      runs,
    ),
    planRefGuardMigration(
      [
        { directory: '/guards', name: '7', destinationExists: false },
        { directory: '/guards', name: '7', destinationExists: true },
        { directory: '/guards', name: '8', destinationExists: false },
      ],
      runs,
    ),
  ]
  for (const plan of shapes) {
    expect(plan.mapped).toHaveLength(1)
    expect(plan.collisions).toHaveLength(1)
    expect(plan.unmapped).toHaveLength(1)
  }
  const markerPlan = planWorktreeMarkerMigration(
    [
      {
        worktree: '/tree',
        marker: {
          state: 'present',
          owner: '7',
          runRecordId: null,
          repoRoot: '/repo',
          source: 'git',
        },
        text: '7\n/repo\nsource: git\n',
      },
      {
        worktree: '/unknown',
        marker: {
          state: 'present',
          owner: '8',
          runRecordId: null,
          repoRoot: '/repo',
          source: 'git',
        },
        text: '8\n/repo\nsource: git\n',
      },
    ],
    runs,
  )
  expect(markerPlan.mapped).toHaveLength(1)
  expect(markerPlan.collisions).toHaveLength(0)
  expect(markerPlan.unmapped).toHaveLength(1)
})
