import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, dir, removeFor, run, upsertProject } from '../test/fixture.ts'
import { scriptedTransportSequence } from '../test/fake-transport.ts'

describe('run confinement warnings',()=>{
test('a moved registered checkout is warned and excluded from the frozen watch set', async () => {
    const movedParent = mkdtempSync(join(tmpdir(), 'orch-moved-project-'))
    const moved = join(movedParent, 'missing-at-launch')
    upsertProject({ name: 'moved-project', path: moved })
    scriptedTransportSequence([
      [{ kind: 'completed', output: 'answer' }],
      [{ kind: 'completed', output: 'answer' }],
    ], () => {
      mkdirSync(moved, { recursive: true })
      writeFileSync(join(moved, 'file.txt'), 'created after launch\n')
    }).install()
    const priorDepth = process.env.ORCH_DEPTH
    const priorMoved = process.env.ORCH_TEST_MOVED_PROJECT
    const originalError = console.error
    const warnings: string[] = []
    process.env.ORCH_DEPTH = '0'
    process.env.ORCH_TEST_MOVED_PROJECT = moved
    try {
      console.error = (...args: unknown[]) => warnings.push(args.join(' '))
      const result = await run({
        job: 'file-question', prompt: 'proceed despite moved checkout', cwd: dir, agent: 'grok',
        keepTree: true,
      })
      const row = db().query(
        'SELECT status, failure_kind FROM run WHERE id=?',
      ).get(result.id) as {
        status: string; failure_kind: string | null
      }
      expect(row).toMatchObject({ status: 'ok', failure_kind: null })
      expect(warnings.filter((line) => line.includes('confinement watch skipped'))).toEqual([
        expect.stringContaining(
          `confinement watch skipped moved-project at ${moved}:`,
        ),
      ])
      expect(warnings[0]).toContain('fix the register with orch project set')
      if (result.worktree) expect(removeFor(result.worktree, result.worktree.repoRoot).removed).toBe(true)

      rmSync(moved, { recursive: true, force: true })
      warnings.length = 0
      const noTree = await run({
        job: 'summarize', prompt: 'no checkout required', cwd: dir, agent: 'grok',
      })
      expect(noTree.worktree).toBeNull()
      expect(warnings.some((line) => line.includes('confinement watch skipped'))).toBe(true)
      const noTreeRow = db().query('SELECT output_path FROM run WHERE id=?').get(noTree.id) as
        { output_path: string }
      expect(readFileSync(noTreeRow.output_path, 'utf8')).toContain(
        `confinement watch skipped moved-project at ${moved}:`,
      )
    } finally {
      console.error = originalError
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      if (priorMoved === undefined) delete process.env.ORCH_TEST_MOVED_PROJECT
      else process.env.ORCH_TEST_MOVED_PROJECT = priorMoved
      rmSync(movedParent, { recursive: true, force: true })
    }
  })
})
