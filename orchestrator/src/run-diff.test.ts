import { expect, test } from 'bun:test'
import { addRun, db, dir, hermeticGitEnv } from '../test/fixture.ts'
import { runDiffCommand } from './run-diff.ts'

test('diff surfaces the recorded base commit', async () => {
  const base = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir, env: hermeticGitEnv(), stdout: 'pipe' }).stdout.toString().trim()
  const id = addRun({ agent: 'codex', job: 'implement' })
  db().query('UPDATE run SET cwd=?,worktree=?,branch=?,base_commit=? WHERE id=?').run(dir, dir, 'fixture', base, id)
  const writes: string[] = []; const errors: string[] = []
  await runDiffCommand(id, { has: () => false }, {
    error: (...values) => errors.push(values.join(' ')), write: (value) => writes.push(value),
    usage: (): never => { throw new Error('usage') }, cleanupRepoRoot: () => dir,
    changesIn: () => ({ diff: '', files: [], insertions: 0, deletions: 0,
      since: base, trunk: 'main', trunkConfigured: false }), writesRepo: () => true,
  })
  expect(writes.join('')).toContain(`base: ${base} (recorded)`)
  expect(errors.join('\n')).toContain(`base:     ${base}`)
})
