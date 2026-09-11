import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noCommitNote } from './collect.ts'

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

  test.each([
    ['an authored commit', { base_commit: base, branch_kept_tip: 'f'.repeat(40), changed_paths: changed }],
    ['no retained tip', { base_commit: base, branch_kept_tip: null, changed_paths: changed }],
    ['nothing changed', { base_commit: base, branch_kept_tip: base, changed_paths: '[]' }],
  ])('%s says nothing', (_name, facts) => {
    expect(noCommitNote(facts, '/nonexistent')).toBe('')
  })
})
