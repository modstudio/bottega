import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SequenceKind, SequenceState } from '../../../shared/git.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { readEventLog, runEventsPath } from '../events.ts'
import { git, gitOk } from '../git/git-environment.ts'
import { checkpointRun } from './checkpoint.ts'
import { decideCheckpointCommit } from './checkpoint-sequencer.ts'

const stopped = (kind: SequenceKind): SequenceState => ({ status: 'in-progress', kind })

test('a checkout with no operation in progress may be checkpointed', () => {
  expect(decideCheckpointCommit({ status: 'none' })).toEqual({ action: 'commit' })
})

test('a leftover pseudo-ref over a clean tree does not stop the commit', () => {
  // projects.ts reads residue the same way: it would block an otherwise clean tree.
  expect(decideCheckpointCommit({ status: 'residue', kind: 'cherry-pick' })).toEqual({
    action: 'commit',
  })
})

test('every unfinished operation stops the commit, named by its own kind', () => {
  const kinds: SequenceKind[] = ['merge', 'cherry-pick', 'rebase', 'revert', 'am', 'bisect']
  for (const kind of kinds) {
    // git am reports as am and bisect as bisect: the answer is git's, not a
    // second list of markers that can disagree with it.
    expect(decideCheckpointCommit(stopped(kind))).toEqual({ action: 'skip', operation: kind })
  }
})

test('a state git cannot report refuses instead of committing', () => {
  expect(decideCheckpointCommit({ status: 'indeterminate' })).toEqual({ action: 'refuse' })
})

const temporary = mkdtempSync(join(tmpdir(), 'orch-checkpoint-sequencer-'))
const branch = 'DEV-1691-sequencer'
const hostContainment = { gitDir: null, hooksDir: null, disableHooks: false } as const
const identity = {
  GIT_AUTHOR_NAME: 'Orch Test',
  GIT_AUTHOR_EMAIL: 'orch@example.invalid',
  GIT_COMMITTER_NAME: 'Orch Test',
  GIT_COMMITTER_EMAIL: 'orch@example.invalid',
}
const commitArgs = ['-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid']

afterAll(() => rmSync(temporary, { recursive: true, force: true }))

function checkpoint(database: Database, repository: string, runId: string) {
  return checkpointRun({
    database,
    runId,
    worktree: repository,
    branch,
    taskKey: 'DEV-1691',
    scratchDir: temporary,
    guardEnvironment: identity,
    containment: hostContainment,
  })
}

/** The shape that cost run 19165: two sides editing one file, stopped by a rebase. */
function stoppedRebaseRepository(name: string): string {
  const repository = join(temporary, name)
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
  // git leaves the conflict half-applied in the tree: this is the state run 19165 committed.
  expect(gitOk(['rebase', 'side'], repository)).toBeNull()
  return repository
}

test('a real stopped rebase is left in the tree, not committed, and recorded', () => {
  const repository = stoppedRebaseRepository('stopped-rebase')
  const database = new Database(':memory:')
  applyMigrations(database)
  fixtureProjectRecordId(database)
  const runId = newRecordId()
  database
    .query(
      `INSERT INTO run (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (1691,?,'2026-10-24','codex','implement','sha',1,'checkpoint','running',
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId)
  const head = git(['rev-parse', 'HEAD'], repository)

  const result = checkpoint(database, repository, runId)

  expect(result.skipped).toBe('rebase')
  expect(result.created).toBe(false)
  expect(result.error).toBeNull()
  expect(git(['rev-parse', 'HEAD'], repository)).toBe(head)
  expect(database.query('SELECT COUNT(*) n FROM run_checkpoint').get()).toEqual({ n: 0 })
  const recorded = readEventLog(runEventsPath(runId)).at(-1)
  expect(recorded).toMatchObject({ type: 'warning' })
  expect(recorded && 'text' in recorded ? recorded.text : '').toContain('rebase')

  // The skip is bounded by the operation: once the rebase is gone, checkpoints commit again.
  git(['rebase', '--abort'], repository)
  writeFileSync(join(repository, 'tracked.ts'), 'export const tracked = "after abort"\n')
  const after = checkpoint(database, repository, runId)
  expect(after.skipped).toBeNull()
  expect(after.created).toBe(true)
  database.close()
})
