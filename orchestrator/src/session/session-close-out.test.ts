import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { addRun, dir, score } from '../../test/fixtures/store.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
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

function addCursor(
  session: string,
  state: 'running' | 'awaiting-ruling',
): {
  recordId: string
  number: number
} {
  return db()
    .query<{ recordId: string; number: number }, (string | number)[]>(
      `INSERT INTO workflow_cursor
        (record_id,number,project,workflow_slug,mode_slug,workflow_key,instance_id,session_id,
         workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
         question,total_steps,created_at,updated_at)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture','flow','default','',?, ?,
               ?,?,'{}',0,'implement',?,'[]',?,1,'2026-11-09','2026-11-09')
       RETURNING record_id recordId,number`,
    )
    .get(
      newRecordId(),
      newRecordId(),
      session,
      workflowVersionRecordId(db()),
      catalogueVersionRecordId(db()),
      state,
      state === 'awaiting-ruling' ? 'Which path?' : '',
    )!
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

test('close-out parks only an awaiting cursor with a recorded open question', async () => {
  const session = newRecordId()
  const parked = addCursor(session, 'awaiting-ruling')
  const missingQuestion = addCursor(session, 'awaiting-ruling')
  const answeredQuestion = addCursor(session, 'awaiting-ruling')
  const running = addCursor(session, 'running')
  const questionId = newRecordId()
  const answeredQuestionId = newRecordId()
  db()
    .query(
      `INSERT INTO question
        (record_id,number,workflow_cursor_record_id,asked_at,question,asked_via)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'2026-11-09','Which path?','workflow')`,
    )
    .run(questionId, parked.recordId)
  db()
    .query(
      `INSERT INTO question
        (record_id,number,workflow_cursor_record_id,asked_at,question,asked_via,answered_at,answer)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM question),?,'2026-11-09','Which path?',
               'workflow','2026-11-09','The other path')`,
    )
    .run(answeredQuestionId, answeredQuestion.recordId)

  const report = await closeOutSession({ session, dryRun: true })

  expect(report.parked).toEqual([
    `workflow cursor ${parked.number}: awaiting recorded question ${questionId}`,
  ])
  expect(report.process).toContainEqual(
    expect.objectContaining({
      item: `workflow cursor ${missingQuestion.number}`,
      remedy:
        `${PLATFORM_SLUG} workflow next flow --cursor ${missingQuestion.number}, or ` +
        `${PLATFORM_SLUG} workflow abandon flow --cursor ${missingQuestion.number} --reason "<why>"`,
    }),
  )
  expect(report.process).toContainEqual(
    expect.objectContaining({
      item: `workflow cursor ${answeredQuestion.number}`,
      remedy:
        `${PLATFORM_SLUG} workflow next flow --cursor ${answeredQuestion.number}, or ` +
        `${PLATFORM_SLUG} workflow abandon flow --cursor ${answeredQuestion.number} --reason "<why>"`,
    }),
  )
  expect(report.parked).not.toContain(
    `workflow cursor ${answeredQuestion.number}: awaiting recorded question ${answeredQuestionId}`,
  )
  expect(report.process).toContainEqual(
    expect.objectContaining({
      item: `workflow cursor ${running.number}`,
      remedy:
        `${PLATFORM_SLUG} workflow next flow --cursor ${running.number}, or ` +
        `${PLATFORM_SLUG} workflow abandon flow --cursor ${running.number} --reason "<why>"`,
    }),
  )
  expect(report.recommendation).toBe('brief')
})

test('dry run reports an owned unscored run as process residue', async () => {
  const session = newRecordId()
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', session })

  const report = await closeOutSession({ session, dryRun: true })

  expect(report.process).toContainEqual(expect.objectContaining({ item: `unscored run ${run}` }))
  expect(report.verdict.clean).toBe(false)
})

test('a completed close-out records its final report while a dry run records nothing', async () => {
  const session = newRecordId()
  await closeOutSession({ session, dryRun: true })
  expect(
    db().query('SELECT COUNT(*) count FROM session_close_out WHERE session_id=?').get(session),
  ).toEqual({ count: 0 })

  await closeOutSession({ session })
  expect(
    db()
      .query(
        `SELECT clean,recommendation,mechanical_count,process_count,error_count,warning_count
           FROM session_close_out WHERE session_id=?`,
      )
      .get(session),
  ).toEqual({
    clean: 1,
    recommendation: 'clear',
    mechanical_count: 1,
    process_count: 0,
    error_count: 0,
    warning_count: 0,
  })
})

describe('configured record close-out', () => {
  let previousUrl: string | undefined

  beforeEach(() => {
    previousUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.BOTTEGA_RECORD_API_URL = 'https://api.example.test'
  })

  afterEach(() => {
    if (previousUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previousUrl
  })

  test('dry-run close-out includes configured pending outbox residue', async () => {
    const session = newRecordId()
    db()
      .query(
        `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,actor_session)
         VALUES (?,'run',?,'{}','2026-11-09T10:00:00.000Z',?)`,
      )
      .run(newRecordId(), newRecordId(), session)
    const report = await closeOutSession({ session, dryRun: true })

    expect(report.process).toContainEqual(
      expect.objectContaining({
        item: '1 pending outbox write(s)',
        remedy: `${PLATFORM_SLUG} record push`,
      }),
    )
    expect(report.verdict.clean).toBe(false)
  })
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

test('an unreadable project warns when the session owns no work that remains there', async () => {
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
  score(root, 'full', 'right', 'faithful')
  attachRunToProject(root, projectId, project)
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    if (command[0] === 'ps' || command[0] === 'lsof') return spawnResult()
    return spawnResult()
  }) as typeof Bun.spawnSync)

  const report = await closeOutSession({ session: 'owner', dryRun: true })

  expect(report.mechanical).toEqual([`would close run ${root}`])
  expect(report.errors).toEqual([])
  expect(report.warnings).toEqual([
    {
      item: `project ${project}`,
      detail: `run resource state could not be read: git common directory could not be read at ${repo}`,
      cleanup:
        `repair the registered checkout, or remove its stale register entry with ` +
        `${PLATFORM_SLUG} project remove ${project}`,
    },
  ])
  expect(report.verdict.clean).toBe(true)
  expect(formatSessionCloseOut(report)).toContain(`warning: project ${project}`)
})

test('an unreadable project remains an error while the session has an unsettled claim', async () => {
  const project = `held-missing-session-close-out-${newRecordId()}`
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
  score(root, 'full', 'right', 'faithful')
  attachRunToProject(root, projectId, project)
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?, ?, ?, ?, 'sandbox_dir', ?, 'claimed', '2026-11-09T00:00:00.000Z')`,
    )
    .run(newRecordId(), root, root, projectId, join(repo, 'missing-sandbox'))
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    if (command[0] === 'ps' || command[0] === 'lsof') return spawnResult()
    return spawnResult('', 1)
  }) as typeof Bun.spawnSync)

  const report = await closeOutSession({ session: 'owner', dryRun: true })

  expect(report.errors).toEqual([
    expect.objectContaining({
      item: `project ${project}`,
      detail: `run resource state could not be read: git common directory could not be read at ${repo}`,
    }),
  ])
  expect(report.warnings).toEqual([])
  expect(report.verdict.clean).toBe(false)
})

test('an unregistered project warning gives the project add form', async () => {
  const project = `retired-session-close-out-${newRecordId()}`
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
  score(root, 'full', 'right', 'faithful')
  attachRunToProject(root, projectId, project)
  db().query('UPDATE project SET retired_at=? WHERE record_id=?').run('2026-11-09', projectId)
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    if (command[0] === 'ps' || command[0] === 'lsof') return spawnResult()
    return spawnResult('', 1)
  }) as typeof Bun.spawnSync)

  const report = await closeOutSession({ session: 'owner', dryRun: true })

  expect(report.errors).toEqual([])
  expect(report.warnings).toEqual([
    expect.objectContaining({
      item: `project ${project}`,
      detail: 'run resource state could not be read: project is not registered',
      cleanup: `register the checkout with ${PLATFORM_SLUG} project add <path> --name ${project}`,
    }),
  ])
})

test('close-out settles an absent ref guard once for an absent terminal tree', async () => {
  const project = `absent-ref-guard-close-out-${newRecordId()}`
  const repo = join(dir, project)
  cleanupPaths.push(repo)
  mkdirSync(join(repo, '.git'), { recursive: true })
  const projectId = registerProject(project, repo)
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'owner' })
  score(root, 'full', 'right', 'faithful')
  attachRunToProject(root, projectId, project)
  const missingTree = join(repo, '.claude', 'worktrees', 'missing')
  const missingGuard = join(repo, '.git', 'orch-guards', root)
  db().query('UPDATE run SET worktree=? WHERE record_id=?').run(missingTree, root)
  const claimRecordId = newRecordId()
  db()
    .query(
      `INSERT INTO resource_claim
       (record_id,root_run_record_id,run_record_id,project_record_id,kind,allocation_key,state,claimed_at)
       VALUES (?, ?, ?, ?, 'ref_guard', ?, 'claimed', '2026-10-20T00:00:00.000Z')`,
    )
    .run(claimRecordId, root, root, projectId, missingGuard)
  spyOn(Bun, 'spawnSync').mockImplementation(((command: string[]) => {
    if (command.includes('--git-common-dir')) return spawnResult('.git\n')
    if (command.includes('for-each-ref')) return spawnResult()
    if (command[0] === 'ps' || command[0] === 'lsof') return spawnResult()
    return spawnResult()
  }) as typeof Bun.spawnSync)

  const first = await closeOutSession({ session: 'owner' })
  const settled = db()
    .query('SELECT state,settled_detail FROM resource_claim WHERE record_id=?')
    .get(claimRecordId) as { state: string; settled_detail: string }
  const second = await closeOutSession({ session: 'owner', dryRun: true })

  expect(first.mechanical).toContain(
    `reconcile claims ${
      (
        db().query('SELECT number FROM resource_claim WHERE record_id=?').get(claimRecordId) as {
          number: number
        }
      ).number
    }`,
  )
  expect(settled).toEqual({
    state: 'absent',
    settled_detail: `observed absent path ${missingGuard}`,
  })
  expect(second.mechanical).not.toContain(`would close run ${root}`)
  expect(second.mechanical.some((line) => line.startsWith('would reconcile claims'))).toBe(false)
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

  expect(report.mechanical).toEqual([
    `would close run ${root}`,
    `would reclaim processes for removed tree ${join(repo, 'missing-tree')}`,
    `would reclaim Compose resources for removed tree ${join(repo, 'missing-tree')}`,
  ])
  expect(report.errors).toEqual([])
})

test('close-out reports a reclaimed Compose stack after releasing an absent terminal tree', async () => {
  const project = `session-close-out-reclaim-${newRecordId()}`
  const repo = join(dir, project)
  cleanupPaths.push(repo)
  mkdirSync(join(repo, '.git'), { recursive: true })
  const projectId = registerProject(project, repo)
  upsertProject({
    recordId: projectId,
    name: project,
    path: repo,
    settings: { trunk: 'main', worktree: { recipePath: '.orch/worktree.jsonc' } },
  })
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'owner' })
  score(root, 'full', 'right', 'faithful')
  attachRunToProject(root, projectId, project)
  const missingTree = join(repo, '.claude', 'worktrees', 'missing-tree')
  db()
    .query(
      `UPDATE run
          SET worktree=?,worktree_source='recipe',recipe_snapshot='{}',resource_teardown='pending'
        WHERE record_id=?`,
    )
    .run(missingTree, root)
  db()
    .query('UPDATE run SET recipe_snapshot=? WHERE record_id=?')
    .run(
      JSON.stringify({
        source: { path: '.orch/worktree.jsonc', commit: 'abc' },
        recipe: { create: [], destroy: [] },
      }),
      root,
    )
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    if (command.includes('--git-common-dir')) return spawnResult('.git\n')
    if (command.startsWith('docker ps -a --format'))
      return spawnResult(`kept-db\t\tkept-stack\t${missingTree}\n`)
    if (command.startsWith('docker volume ls --format')) return spawnResult()
    if (command === 'docker network ls --format {{.Name}}') return spawnResult()
    if (args[0] === 'ps' || args[0] === 'lsof') return spawnResult()
    return spawnResult()
  }) as typeof Bun.spawnSync)

  const report = await closeOutSession({ session: 'owner' })

  expect(report.mechanical).toContain(`close run ${root}`)
  expect(report.mechanical).toContain('reclaimed Compose resource: kept-db')
  expect(report.verdict.clean).toBe(true)
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
