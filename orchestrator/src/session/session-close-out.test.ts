import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { addRun, dir, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { encodeContextItem } from '../doc/context-item-codec.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from '../doc/context-write-adapter.ts'
import { upsertProject } from '../project/projects.ts'
import { closeOutSession, formatSessionCloseOut } from './session-close-out.ts'

const cleanupPaths: string[] = []

afterEach(() => {
  mock.restore()
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

function spawnResult(stdout = '', exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}

function registerProject(name: string, path: string): string {
  const recordId = newRecordId()
  upsertProject({ recordId, name, path, settings: { trunk: 'main' } })
  return recordId
}

function attachRunToProject(runId: string, projectId: string, project: string): void {
  db()
    .query('UPDATE run SET project_record_id=?,repo=? WHERE record_id=?')
    .run(projectId, project, runId)
}

test('dry run reports context drops and refusals while resume keeps every item', async () => {
  const session = newRecordId()
  ;(globalThis as typeof globalThis & { [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts })[
    CONTEXT_FACTS_PORTS_KEY
  ] = { tasks: async () => [], pointer: async () => null }
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  await setDoc({
    scope: 'context',
    subject: `session:${session}`,
    slug: 'fact',
    title: 'fact',
    body: encodeContextItem({ kind: 'fact', source: 'test', body: 'carry this fact' }),
  })
  await setDoc({
    scope: 'context',
    subject: `session:${session}`,
    slug: 'ruling',
    title: 'ruling',
    body: encodeContextItem({ kind: 'ruling', source: 'q5282', body: 'approved' }),
  })
  if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = previousSession

  const dry = await closeOutSession({ session, dryRun: true })
  expect(dry.mechanical).toContain(`would drop context session:${session}/fact (fact)`)
  expect(dry.process).toContainEqual(
    expect.objectContaining({
      item: `context session:${session}/ruling (ruling)`,
      reason: expect.stringContaining('would refuse'),
    }),
  )

  const resume = await closeOutSession({ session, dryRun: true, resume: true })
  expect(resume.kept).toEqual([
    `context session:${session}/fact (fact)`,
    `context session:${session}/ruling (ruling)`,
  ])
  expect(resume.recommendation).toBe('brief')
})

test('close-out refuses to drop a context item whose revision is unavailable', async () => {
  const session = newRecordId()
  const prior = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  const item = await setDoc({
    scope: 'context',
    subject: `session:${session}`,
    slug: 'revisionless',
    title: 'revisionless',
    body: encodeContextItem({ kind: 'fact', source: 'test', body: 'must survive' }),
  })
  if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = prior
  db().query('DELETE FROM doc_revision WHERE doc_record_id=?').run(item.record_id)

  const report = await closeOutSession({ session })

  expect(report.errors).toContainEqual(
    expect.objectContaining({
      item: `context session:${session}/revisionless (fact)`,
      detail: 'context item revision is unavailable',
    }),
  )
  expect(db().query('SELECT 1 FROM doc WHERE record_id=?').get(item.record_id)).not.toBeNull()
})

test("a turn's guard or retained ref makes its terminal root planned", async () => {
  const project = `session-close-out-${newRecordId()}`
  const repo = join(dir, project)
  cleanupPaths.push(repo)
  mkdirSync(join(repo, '.git'), { recursive: true })
  const projectId = registerProject(project, repo)
  const guardRoot = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'owner' })
  const guardTurn = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: guardRoot,
    turn: 2,
  })
  const retainedRoot = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    session: 'owner',
  })
  const retainedTurn = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    parent: retainedRoot,
    turn: 2,
  })
  score(guardRoot, 'full', 'right', 'faithful')
  score(retainedRoot, 'full', 'right', 'faithful')
  for (const runId of [guardRoot, guardTurn, retainedRoot, retainedTurn])
    attachRunToProject(runId, projectId, project)
  mkdirSync(join(repo, '.git', 'orch-guards', guardTurn), { recursive: true })
  const claimRecordId = newRecordId()
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?, ?, ?, ?, 'database', 'fixture', 'claimed', '2026-10-20T00:00:00.000Z')`,
    )
    .run(claimRecordId, retainedRoot, retainedTurn, projectId)
  const claimId = (
    db().query('SELECT number FROM resource_claim WHERE record_id=?').get(claimRecordId) as {
      number: number
    }
  ).number
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    if (command.includes('--git-common-dir')) return spawnResult('.git\n')
    if (command.includes('for-each-ref')) return spawnResult(`refs/orch/retained/${retainedTurn}\n`)
    if (command[0] === 'ps' || command[0] === 'lsof') return spawnResult()
    return spawnResult()
  }) as typeof Bun.spawnSync)

  const report = await closeOutSession({ session: 'owner', dryRun: true })

  expect(report.mechanical).toEqual([
    `would close run ${guardRoot}`,
    `would close run ${retainedRoot}`,
    `would reconcile claims ${claimId}`,
  ])
  expect(report.errors).toEqual([])
  expect(report.verdict).toEqual({ clean: true, residue: 0 })
  expect(formatSessionCloseOut(report)).toContain(
    'owned items would be released by the 3 planned action(s); session would then be clean',
  )
})

test('an unreadable project reports an error and conservatively plans its root', async () => {
  const project = `missing-session-close-out-${newRecordId()}`
  const repo = join(dir, project)
  const projectId = registerProject(project, repo)
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    session: 'owner',
    taskRecordId: 'fixture-task',
    projectRecordId: null,
  })
  attachRunToProject(root, projectId, project)
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    if (command[0] === 'ps' || command[0] === 'lsof') return spawnResult()
    return spawnResult()
  }) as typeof Bun.spawnSync)

  const report = await closeOutSession({ session: 'owner', dryRun: true })

  expect(report.mechanical).toEqual([`would close run ${root}`])
  expect(report.errors).toEqual([
    {
      item: `project ${project}`,
      detail: `run resource state could not be read: git common directory could not be read at ${repo}`,
      retry: `${PLATFORM_SLUG} machine doctor`,
    },
  ])
  expect(report.verdict.clean).toBe(false)
})

test('an absent tree that owes recorded teardown makes its terminal root planned', async () => {
  const project = `session-close-out-teardown-${newRecordId()}`
  const repo = join(dir, project)
  cleanupPaths.push(repo)
  mkdirSync(join(repo, '.git'), { recursive: true })
  const projectId = registerProject(project, repo)
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'owner' })
  attachRunToProject(root, projectId, project)
  db()
    .query(
      `UPDATE run
          SET worktree=?,worktree_source='recipe',recipe_snapshot='{}',resource_teardown='pending'
        WHERE record_id=?`,
    )
    .run(join(repo, 'missing-tree'), root)
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    if (command.includes('--git-common-dir')) return spawnResult('.git\n')
    if (command[0] === 'ps' || command[0] === 'lsof') return spawnResult()
    return spawnResult()
  }) as typeof Bun.spawnSync)

  const report = await closeOutSession({ session: 'owner', dryRun: true })

  expect(report.mechanical).toEqual([`would close run ${root}`])
  expect(report.errors).toEqual([])
})

test('a terminal root without a project is planned because its held state is unknown', async () => {
  const root = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'ok',
    session: 'owner',
    taskRecordId: 'fixture-task',
    projectRecordId: null,
  })

  const report = await closeOutSession({ session: 'owner', dryRun: true })

  expect(report.mechanical).toEqual([`would close run ${root}`])
  expect(report.errors).toEqual([])
})
