import { expect, test } from 'bun:test'
import { addRun, db, dir } from '../test/fixture.ts'
import { discardRun } from './cleanup.ts'

const presentation = {
  log: () => {}, error: () => {}, setExitCode: () => {},
  keptBranchLine: (branch: string) => `kept branch ${branch}`,
}

test('discard resolves a child to its root owner before filesystem mutation', async () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'orch-test-session'
  const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'other-session' })
  const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: root, turn: 2 })
  const path = `${dir}/foreign-owned-worktree`
  db().query('UPDATE run SET worktree=? WHERE id=?').run(path, child)
  await expect(discardRun(child, { force: true, auditReason: null, presentation }))
    .rejects.toThrow(`run ${child} is owned by session other-session`)
  expect(db().query('SELECT worktree FROM run WHERE id=?').get(child)).toEqual({ worktree: path })
  expect(db().query('SELECT COUNT(*) n FROM run_mutation_audit').get()).toEqual({ n: 0 })
})

