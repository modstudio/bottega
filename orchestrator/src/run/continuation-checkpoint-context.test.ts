import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { git, gitOk } from '../git/git-environment.ts'
import { continuationCheckpointContext } from './continuation-checkpoint-context.ts'
import { continuationResumeKind } from './run-resume-kind.ts'

test('uses the resolved continuation tree tip as the checkpoint prompt start', () => {
  const rootId = addRun({ agent: 'codex', job: 'implement' })
  db()
    .query(
      `INSERT INTO run_checkpoint
         (record_id, run_record_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
       VALUES ('${newRecordId()}', ?,?,?,?,?,?)`,
    )
    .run(rootId, 2, 'earlier-checkpoint', null, 0, new Date().toISOString())

  const { context, hasCheckpoint } = continuationCheckpointContext({
    database: db(),
    rootId,
    worktree: null,
    treePlan: {
      action: 'attach-recorded',
      branch: 'DEV-970-resume-tip',
      tip: 'resolved-branch-tip',
      tipSource: 'branch ref',
      rootId,
    },
  })

  expect(context).toContain('Resume at resolved-branch-tip on DEV-970-resume-tip.')
  expect(context).toContain(
    'Latest harness checkpoint #2 at earlier-checkpoint is earlier than the start commit',
  )
  expect(context).not.toContain('Resume from checkpoint')
  expect(hasCheckpoint).toBe(true)
})

test('a checkpoint without a resolved continuation tree gives the fresh-run remedy', () => {
  const rootId = addRun({ agent: 'codex', job: 'implement' })
  db().query('UPDATE run SET launch_key=? WHERE record_id=?').run('DEV-970', rootId)
  db()
    .query(
      `INSERT INTO run_checkpoint
         (record_id, run_record_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
       VALUES ('${newRecordId()}', ?,?,?,?,?,?)`,
    )
    .run(rootId, 1, 'checkpoint-without-tree', null, 0, new Date().toISOString())

  expect(() =>
    continuationCheckpointContext({
      database: db(),
      rootId,
      worktree: null,
      treePlan: null,
    }),
  ).toThrow(
    `run ${rootId} has a checkpoint but no branch or retained ref resolves for its latest started turn; ` +
      'invariant: a resume prompt names only the commit the resumed tree exposes; ' +
      `remedy: start a fresh keyed run from a known base with ${PLATFORM_SLUG} run start implement --key DEV-970 --base <ref>`,
  )
})

const temporary = mkdtempSync(join(tmpdir(), 'orch-continuation-checkpoint-'))
const branch = 'DEV-1691-continuation'
const commitArgs = ['-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid']

test('a worktree mid-rebase with no checkpoint row gets the block and keeps the conversation', () => {
  const repository = join(temporary, 'stopped-rebase')
  mkdirSync(repository)
  git(['init', '-b', branch], repository)
  writeFileSync(join(repository, 'tracked.ts'), 'export const tracked = "initial"\n')
  git(['add', 'tracked.ts'], repository)
  git([...commitArgs, 'commit', '-q', '-m', 'initial'], repository)
  git(['checkout', '-q', '-b', 'side'], repository)
  writeFileSync(join(repository, 'tracked.ts'), 'export const tracked = "side"\n')
  git([...commitArgs, 'commit', '-qam', 'side'], repository)
  git(['checkout', '-q', branch], repository)
  writeFileSync(join(repository, 'tracked.ts'), 'export const tracked = "branch"\n')
  git([...commitArgs, 'commit', '-qam', 'branch'], repository)
  expect(gitOk(['rebase', 'side'], repository)).toBeNull()

  const rootId = addRun({ agent: 'codex', job: 'implement' })
  const saved = continuationCheckpointContext({
    database: db(),
    rootId,
    worktree: repository,
    treePlan: null,
  })

  expect(saved.hasCheckpoint).toBe(false)
  expect(saved.context).toBe(
    'CHECKPOINT RESUME\n' +
      'A rebase is in progress in this worktree; finish or abort it before you commit.',
  )
  expect(continuationResumeKind(saved.hasCheckpoint)).toBe('continue')

  git(['rebase', '--abort'], repository)
  expect(
    continuationCheckpointContext({
      database: db(),
      rootId,
      worktree: repository,
      treePlan: null,
    }).context,
  ).toBeNull()
  rmSync(temporary, { recursive: true, force: true })
})
