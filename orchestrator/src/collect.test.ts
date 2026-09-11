import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectResult, collectWait, noCommitNote, thinOutputWarning } from './collect.ts'
import { addRun, db, dir } from '../test/fixture.ts'

const base = '3646a62f6abd4486aeb2c27744d2f69ba7210828'
const changed = JSON.stringify(['.githooks/pre-commit'])

describe('no-commit report', () => {
  test('a branch left at its base with changed paths names the extracted copies that exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-no-commit-'))
    try {
      writeFileSync(join(dir, 'uncommitted.patch'), 'diff\n')
      mkdirSync(join(dir, 'untracked'))
      const note = noCommitNote({ base_commit: base, branch_kept_tip: base, changed_paths: changed }, dir)
      expect(note).toContain('no commit authored')
      expect(note).toContain(join(dir, 'uncommitted.patch'))
      expect(note).toContain(join(dir, 'untracked'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('never names an artifact that is not on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-no-commit-'))
    try {
      const note = noCommitNote({ base_commit: base, branch_kept_tip: base, changed_paths: changed }, dir)
      expect(note).toContain('no commit authored')
      expect(note).not.toContain('uncommitted.patch')
      expect(note).toContain(`no extracted artifact (checked ${dir})`)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a run with no recorded runs directory still says no commit was authored', () => {
    const note = noCommitNote({ base_commit: base, branch_kept_tip: base, changed_paths: changed }, null)
    expect(note).toContain('no commit authored')
    expect(note).toContain('the run records no runs directory')
  })

  test.each([
    ['an authored commit', { base_commit: base, branch_kept_tip: 'f'.repeat(40), changed_paths: changed }],
    ['no retained tip', { base_commit: base, branch_kept_tip: null, changed_paths: changed }],
    ['nothing changed', { base_commit: base, branch_kept_tip: base, changed_paths: '[]' }],
  ])('%s says nothing', (_name, facts) => {
    expect(noCommitNote(facts, '/nonexistent')).toBe('')
  })
})

describe('thin output warning', () => {
  test('result and runs flag only slow, thin, non-probe answer output', () => {
    const output = join(mkdtempSync(join(tmpdir(), 'orch-thin-output-')), 'answer.txt')
    writeFileSync(output, 'x'.repeat(600))
    const row = { job: 'diagnose', status: 'ok', latency_ms: 400_000, probe: 0, output_path: output }
    expect(thinOutputWarning(row)).toBe('thin: 600 B after 6m40s — check whether the run stopped at a blocker')
    expect(thinOutputWarning({ ...row, latency_ms: 300_000 })).toBeNull()
    expect(thinOutputWarning({ ...row, probe: 1 })).toBeNull()
    rmSync(output, { force: true }); rmSync(join(output, '..'), { recursive: true, force: true })
  })

  test('a thin output expiring between exists and stat suppresses only the warning', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orch-expiring-thin-'))
    const output = join(directory, 'answer.txt')
    writeFileSync(output, 'x'.repeat(600))
    process.env.ORCH_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT = output
    try {
      expect(thinOutputWarning({ job: 'diagnose', status: 'ok', latency_ms: 400_000, probe: 0, output_path: output })).toBeNull()
      expect(existsSync(output)).toBe(false)
    } finally {
      delete process.env.ORCH_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('collection records', () => {
  test('result surfaces the recorded base commit for a writing run', () => {
    const id = addRun({ agent: 'codex', job: 'implement' }); db().query('UPDATE run SET base_commit=? WHERE id=?').run('base-commit-123', id)
    const errors: string[] = []; const error = spyOn(console, 'error').mockImplementation((...parts) => { errors.push(parts.join(' ')) })
    try { collectResult(db(), ['result', String(id)]) } finally { error.mockRestore() }
    expect(errors.join('\n')).toContain('base:      base-commit-123')
  })

  test('a failed run wraps partial JSON so it cannot parse as a completed review', () => {
    const id = addRun({ agent: 'codex', job: 'review-lens', status: 'failed' }); const output = join(dir, `failed-partial-${id}.txt`); const partial = { findings: [], provenance: { tree_inspected: 'two invalidators' } }; writeFileSync(output, JSON.stringify(partial)); db().query("UPDATE run SET output_path=?,error='agent died',failure_kind='interrupted',exit_code=1 WHERE id=?").run(output, id)
    const logs: string[] = []; const log = spyOn(console, 'log').mockImplementation((...parts) => { logs.push(parts.join(' ')) }); const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`EXIT:${code}`) }) as never)
    try { expect(() => collectResult(db(), ['result', String(id)])).toThrow('EXIT:1') } finally { log.mockRestore(); exit.mockRestore() }
    const shown = JSON.parse(logs.join('\n')); expect(shown.run).toMatchObject({ id, status: 'failed', complete: false }); expect(shown.findings).toBeUndefined(); expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(partial)
  })

  test('waiting on a failed run exits non-zero', async () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' }); db().query("UPDATE run SET error='worktree creation failed',failure_kind='harness',exit_code=17 WHERE id=?").run(id)
    const logs: string[] = []; const log = spyOn(console, 'log').mockImplementation((...parts) => { logs.push(parts.join(' ')) }); const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`EXIT:${code}`) }) as never)
    try { await expect(collectWait(db(), ['wait', String(id)])).rejects.toThrow('EXIT:1') } finally { log.mockRestore(); exit.mockRestore() }
    expect(logs.join('\n')).toContain(`${id}\tfailed`); expect(logs.join('\n')).toContain('harness: worktree creation failed')
  })
})
