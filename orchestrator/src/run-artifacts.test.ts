import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KEEP_RUN_FILES_DAYS, addRun, db, dir, pruneRuns, runFilePaths,
} from '../test/fixture.ts'
import { listRunArtifacts, persistRunArtifacts, readDispatchState, runArtifactsDir, runScratchDir, writeDispatchState } from './run-artifacts.ts'

describe('run files are named by their run, not by the clock', () => {
  /**
   * Six review lenses fired concurrently put three runs inside one millisecond
   * with the same agent and job, so they shared a prompt file AND an output
   * file. Each worker read whichever prompt was written last, and all three
   * answered the same question while claiming to be three different lenses.
   * The session that hit it scored two of them `none` and caught it only
   * because the content did not match what it had asked for.
   *
   * The stored paths are the evidence, so the test reads them: two runs of the
   * same job started in the same millisecond must not name the same file.
   */
  test('neither call site names a run file from the clock alone', () => {
    // Asserted against the SOURCE, the way the stale-`blocked` guard is, because
    // reproducing a millisecond collision on demand is a race the test would
    // lose more often than the bug did.
    const dir = new URL('.', import.meta.url).pathname
    for (const file of ['run-artifacts.ts', 'cli.ts']) {
      // Comments quote the OLD pattern on purpose, to record what went wrong.
      const code = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')
      for (const n of code.match(/`\$\{Date\.now\(\)\}[^`]*`/g) ?? []) {
        expect(n).toMatch(/reserveId|unique|randomUUID/)
      }
    }
  })

  test('two runs created in the same millisecond have distinct paths', () => {
    const clock = 1_700_000_000_000
    const first = runFilePaths(dir, clock, 1, 'codex', 'review-lens')
    const second = runFilePaths(dir, clock, 2, 'codex', 'review-lens')
    expect(first.prompt).not.toBe(second.prompt)
    expect(first.output).not.toBe(second.output)
  })
})

describe('run file pruning', () => {
  test('deleting expired files nulls their matching database paths', () => {
    const files = join(dir, 'prune-files')
    try {
      mkdirSync(files)
      const prompt = join(files, 'old.prompt.txt')
      const output = join(files, 'old.txt')
      writeFileSync(prompt, 'prompt')
      writeFileSync(output, 'output')
      const old = new Date(Date.now() - (KEEP_RUN_FILES_DAYS + 1) * 86_400_000)
      utimesSync(prompt, old, old)
      utimesSync(output, old, old)
      const id = addRun({ agent: 'codex', job: 'file-question' })
      db().query('UPDATE run SET prompt_path=?, output_path=? WHERE id=?').run(prompt, output, id)

      pruneRuns(files)

      expect(existsSync(prompt)).toBe(false)
      expect(existsSync(output)).toBe(false)
      expect(db().query('SELECT prompt_path, output_path FROM run WHERE id=?').get(id))
        .toEqual({ prompt_path: null, output_path: null })
    } finally {
      rmSync(files, { recursive: true, force: true })
    }
  })
})

test('artifacts are copied and listed', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' }); const tree = mkdtempSync(join(tmpdir(), 'orch-artifact-tree-'))
  mkdirSync(runScratchDir(id), { recursive: true }); writeFileSync(join(runScratchDir(id), 'timing-table.txt'), 'file,ms\na,1\n'); writeFileSync(join(tree, 'named-evidence.txt'), 'failing test\n')
  try { persistRunArtifacts(id, ['named-evidence.txt'], { path: tree }, { diff: 'fixture changed\n' }); const files = listRunArtifacts(id); expect(files.some((path) => path.endsWith('timing-table.txt'))).toBe(true); expect(readFileSync(files.find((path) => path.endsWith('named-evidence.txt'))!, 'utf8')).toContain('failing test'); expect(readFileSync(files.find((path) => path.endsWith('worktree.diff'))!, 'utf8')).toContain('fixture changed') }
  finally { rmSync(tree, { recursive: true, force: true }) }
})
test('a reclaimed lens tree leaves its artifacts', () => {
  const id = addRun({ agent: 'codex', job: 'review-lens' }); const tree = mkdtempSync(join(tmpdir(), 'orch-lens-tree-')); mkdirSync(runScratchDir(id), { recursive: true }); writeFileSync(join(runScratchDir(id), 'lens-note.txt'), 'covered\n')
  persistRunArtifacts(id, null, { path: tree }, null); rmSync(tree, { recursive: true, force: true })
  expect(existsSync(runArtifactsDir(id))).toBe(true); expect(listRunArtifacts(id).some((path) => path.endsWith('lens-note.txt'))).toBe(true)
})
test('an artifact copy failure records a harness failure and preserves the tree', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose' }); const tree = mkdtempSync(join(tmpdir(), 'orch-failed-artifact-tree-'))
  try { expect(() => persistRunArtifacts(id, ['missing-evidence.txt'], { path: tree }, null)).toThrow(`could not copy named file ${join(tree, 'missing-evidence.txt')}`); expect(existsSync(tree)).toBe(true); expect(existsSync(runArtifactsDir(id))).toBe(true) }
  finally { rmSync(tree, { recursive: true, force: true }) }
})
test('an artifact persistence failure cannot overwrite a concurrent operator stop', () => {
  const id = addRun({ agent: 'codex', job: 'diagnose', status: 'stopped' }); const tree = mkdtempSync(join(tmpdir(), 'orch-stopped-artifact-tree-'))
  try { expect(() => persistRunArtifacts(id, ['missing'], { path: tree }, null)).toThrow(); expect(db().query('SELECT status FROM run WHERE id=?').get(id)).toEqual({ status: 'stopped' }) }
  finally { rmSync(tree, { recursive: true, force: true }) }
})
test('orch retry preserves a reader root deliverable contract and timeout', () => {
  const root = addRun({ agent: 'codex', job: 'understand' }); const child = addRun({ agent: 'grok', job: 'understand', parent: root, turn: 2 })
  writeDispatchState(root, { deliverables: ['x'], timeoutMinutes: 17 }); writeDispatchState(child, readDispatchState(root))
  expect(readDispatchState(child)).toEqual({ deliverables: ['x'], timeoutMinutes: 17 })
})
