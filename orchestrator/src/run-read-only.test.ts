import { describe, expect, test } from "bun:test"
import { rmSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { declaredCreate, worktreeDescribeFixture } from '../test/fixtures/worktree.ts'
import { db } from './db.ts'
import { upsertProject } from './projects.ts'
import { run as runJob } from './run.ts'
import { removeFor } from './worktree.ts'
import { scriptedTransport } from "../test/fake-transport.ts"
describe('read-only run worktrees', () => {
const { git, scratchRepo } = worktreeDescribeFixture()
test('a recipe-project read-only run records git source and warns that infrastructure is absent', async () => {
    const { repo, tree } = scratchRepo()
    const invoked = join(repo, 'writing-create-invoked')
    writeFileSync(join(tree, 'feature.txt'), 'feature state\n')
    git(tree, 'add', 'feature.txt')
    git(tree, 'commit', '-m', 'feature state')
    const featureHead = git(tree, 'rev-parse', 'HEAD')
    expect(featureHead).not.toBe(git(repo, 'rev-parse', 'main'))
    upsertProject({
      name: 'read-only-run-recipe', path: repo,
      settings: { worktree: {
        create: declaredCreate(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(invoked)}, 'yes')`]),
        remove: `printf removed`, branch: '{key}-orch-{id}', seeds: ['full'],
      } },
    })
    const transport = scriptedTransport([{ kind: 'completed', output: 'inspected' }])
    transport.install()
    try {
      process.env.ORCH_DEPTH = '0'
      const result = await runJob({
        job: 'file-question', prompt: 'inspect', cwd: tree, agent: 'codex', keepTree: true,
      })
      expect(existsSync(invoked)).toBe(false)
      expect(result.worktree?.source).toBe('git')
      expect(result.worktree?.base).toBe(featureHead)
      expect(git(result.worktree!.path, 'rev-parse', 'HEAD')).toBe(featureHead)
      expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], { cwd: result.worktree!.path }).exitCode).not.toBe(0)
      expect(db().query('SELECT worktree_source, branch FROM run WHERE id=?').get(result.id))
        .toEqual({ worktree_source: 'git', branch: null })
      expect(transport.prompts.join('\n')).toContain('NO provisioned infrastructure')
      expect(transport.prompts.join('\n')).toContain(`project's files at ${featureHead}`)
      expect(transport.prompts.join('\n')).toContain('no databases, no generated env, no vendor tree')
      expect(transport.prompts.join('\n')).toContain('could_not_verify')
      expect(removeFor(result.worktree!, repo).removed).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('a read-only run uses the project\'s declared infrastructure note', async () => {
    const { repo, tree } = scratchRepo()
    const note = 'Dependencies are installed and bun run test uses in-process PGlite.'
    upsertProject({
      name: 'read-only-run-notes', path: repo,
      settings: { worktree: { recipe: {}, readonly_notes: note } },
    })
    const transport = scriptedTransport([{ kind: 'completed', output: 'inspected' }])
    transport.install()
    try {
      process.env.ORCH_DEPTH = '0'
      const result = await runJob({
        job: 'file-question', prompt: 'inspect', cwd: tree, agent: 'codex', keepTree: true,
      })
      expect(transport.prompts.join('\n')).toContain(`This read-only run has the project's files at ${result.worktree!.base}. ${note}`)
      expect(transport.prompts.join('\n')).not.toContain('NO provisioned infrastructure')
      expect(transport.prompts.join('\n')).toContain('record what you could not run in could_not_verify')
      expect(removeFor(result.worktree!, repo).removed).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
