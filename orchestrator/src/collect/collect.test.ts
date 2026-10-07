import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import {
  branchNote,
  collectResult,
  collectWait,
  mintedBranchForRun,
  noCommitNote,
  releasedWritingTreeNote,
  thinOutputWarning,
} from './collect.ts'

const recordedResult = (id: number) => {
  const logs: string[] = []
  const errors: string[] = []
  collectResult(db(), ['result', String(id)], () => '', {
    log: (...values) => logs.push(values.join(' ')),
    error: (...values) => errors.push(values.join(' ')),
    exit: (code): never => {
      throw new Error(`EXIT:${code}`)
    },
  })
  return { logs, errors }
}

const base = '3646a62f6abd4486aeb2c27744d2f69ba7210828'
const changed = JSON.stringify(['.githooks/pre-commit'])

describe('no-commit report', () => {
  test('rejects comparing no-commit evidence against any base and head except the turn own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-no-commit-'))
    try {
      writeFileSync(join(dir, 'uncommitted.patch'), 'diff\n')
      mkdirSync(join(dir, 'untracked'))
      const note = noCommitNote(
        { base_commit: base, branch_kept_tip: base, changed_paths: changed },
        dir,
      )
      expect(note).toContain('no commit authored')
      expect(note).toContain(join(dir, 'uncommitted.patch'))
      expect(note).toContain(join(dir, 'untracked'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('never names an artifact that is not on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-no-commit-'))
    try {
      const note = noCommitNote(
        { base_commit: base, branch_kept_tip: base, changed_paths: changed },
        dir,
      )
      expect(note).toContain('no commit authored')
      expect(note).not.toContain('uncommitted.patch')
      expect(note).toContain(`no extracted artifact (checked ${dir})`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a run with no recorded runs directory still says no commit was authored', () => {
    const note = noCommitNote(
      { base_commit: base, branch_kept_tip: base, changed_paths: changed },
      null,
    )
    expect(note).toContain('no commit authored')
    expect(note).toContain('the run records no runs directory')
  })

  test.each([
    [
      'an authored commit',
      { base_commit: base, branch_kept_tip: 'f'.repeat(40), changed_paths: changed },
    ],
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
    const row = {
      job: 'diagnose',
      status: 'ok',
      latency_ms: 400_000,
      probe: 0,
      output_path: output,
      writesRepo: false,
    }
    expect(thinOutputWarning(row)).toBe(
      'thin: 600 B after 6m40s — check whether the run stopped at a blocker',
    )
    expect(thinOutputWarning({ ...row, latency_ms: 300_000 })).toBeNull()
    expect(thinOutputWarning({ ...row, probe: 1 })).toBeNull()
    rmSync(output, { force: true })
    rmSync(join(output, '..'), { recursive: true, force: true })
  })

  test('a thin output expiring between exists and stat suppresses only the warning', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orch-expiring-thin-'))
    const output = join(directory, 'answer.txt')
    writeFileSync(output, 'x'.repeat(600))
    process.env.ORCH_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT = output
    try {
      expect(
        thinOutputWarning({
          job: 'diagnose',
          status: 'ok',
          latency_ms: 400_000,
          probe: 0,
          output_path: output,
          writesRepo: false,
        }),
      ).toBeNull()
      expect(existsSync(output)).toBe(false)
    } finally {
      delete process.env.ORCH_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('collection records', () => {
  test('result shows an ok outcome note directly before the score hint', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET error=? WHERE id=?').run('this turn changed nothing', id)
    const shown = recordedResult(id).errors.join('\n')
    expect(shown).toContain(
      `— run ${id} · codex · 1.0s · vendor tokens not reported\n  this turn changed nothing\n  score it:`,
    )
  })

  test('result rendering is byte-identical when an ok run has no outcome note', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    expect(recordedResult(id).errors).toEqual([
      `\n— run ${id} · codex · 1.0s · vendor tokens not reported\n  score it:  orch score ${id} <none|partial|full> [wrong|mixed|right] --note "..."`,
    ])
  })

  test.each([
    ['tree present', { writingRun: true, worktree: '/tmp/tree' }, ''],
    ['tree released', { writingRun: true, worktree: null }, '\n  open tree:  orch tree open 42'],
    ['non-writing run', { writingRun: false, worktree: null }, ''],
  ])('%s controls the open-tree footer', (_name, facts, expected) => {
    expect(releasedWritingTreeNote(facts, 42)).toBe(expected)
  })

  test('--follow names the branch minted by a writing run', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET minted_branch=? WHERE id=?').run('feature/DEV-498', id)
    expect(branchNote(db(), id)).toContain('feature/DEV-498')
  })

  test('every score hint names the ROOT, never the turn it printed after', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    const errors: string[] = []
    const spy = spyOn(console, 'error').mockImplementation((...parts) => {
      errors.push(parts.join(' '))
    })
    try {
      collectResult(db(), ['result', String(child)])
    } finally {
      spy.mockRestore()
    }
    expect(errors.join('\n')).toContain(`score it:  orch score ${root}`)
    expect(errors.join('\n')).not.toContain(`score it:  orch score ${child}`)
  })

  test('result and wait name the branch actually minted for a writing run', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET minted_branch=? WHERE id=?').run('feature/minted', id)
    expect(mintedBranchForRun(db(), id)).toBe('feature/minted')
    expect(branchNote(db(), id)).toContain('feature/minted')
  })

  test('result and wait add no branch detail when the run minted no branch', () => {
    const id = addRun({ agent: 'codex', job: 'file-question' })
    expect(mintedBranchForRun(db(), id)).toBeNull()
    expect(branchNote(db(), id)).toBe('')
  })

  test('a resumed chain reports the branch the turn actually ran on', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db().query('UPDATE run SET minted_branch=? WHERE id=?').run('root-owned', root)
    db().query('UPDATE run SET branch=?,minted_branch=NULL WHERE id=?').run('turn-branch', child)
    expect(mintedBranchForRun(db(), child)).toBe('turn-branch')
  })

  test('a root authored commit does not suppress the turn own no-commit warning', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db()
      .query('UPDATE run SET branch=?,base_commit=?,branch_kept_tip=?,changed_paths=? WHERE id=?')
      .run('root-branch', base, 'f'.repeat(40), changed, root)
    db()
      .query('UPDATE run SET branch=?,base_commit=?,branch_kept_tip=?,changed_paths=? WHERE id=?')
      .run('turn-branch', base, base, changed, child)

    const note = branchNote(db(), child)
    expect(note).toContain('branch:    turn-branch')
    expect(note).toContain('no commit authored')
  })

  test('waiting on ok and asking runs succeeds and points to the inbox', async () => {
    const ok = addRun({ agent: 'codex', job: 'file-question' })
    const asking = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
      .run(asking, new Date().toISOString(), 'which?')
    const logs: string[] = []
    const spy = spyOn(console, 'log').mockImplementation((...parts) => {
      logs.push(parts.join(' '))
    })
    try {
      await collectWait(db(), ['wait', String(ok), String(asking)])
    } finally {
      spy.mockRestore()
    }
    expect(logs.join('\n')).toContain(`${asking}\tasking - orch inbox`)
  })

  test('a flag value is not mistaken for a run id', async () => {
    const id = addRun({ agent: 'codex', job: 'file-question' })
    const logs: string[] = []
    const spy = spyOn(console, 'log').mockImplementation((...parts) => {
      logs.push(parts.join(' '))
    })
    try {
      await collectWait(db(), ['wait', String(id), '--timeout', '300'])
    } finally {
      spy.mockRestore()
    }
    expect(logs.join('\n')).toContain(`${id}\tok`)
    expect(logs.join('\n')).not.toContain('300\t')
  })

  test('wait names the root, not the asking tip, when a question is open', async () => {
    const root = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    const child = addRun({
      agent: 'codex',
      job: 'file-question',
      status: 'asking',
      parent: root,
      turn: 2,
    })
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'which?')
    const logs: string[] = []
    const spy = spyOn(console, 'log').mockImplementation((...parts) => {
      logs.push(parts.join(' '))
    })
    try {
      await collectWait(db(), ['wait', String(child)])
    } finally {
      spy.mockRestore()
    }
    expect(logs.join('\n')).toContain(`orch answer ${root}`)
  })

  test('wait exposes an asking chain with no open question or running turn as recoverable', async () => {
    const root = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    const logs: string[] = []
    const spy = spyOn(console, 'log').mockImplementation((...parts) => {
      logs.push(parts.join(' '))
    })
    try {
      await collectWait(db(), ['wait', String(root)])
    } finally {
      spy.mockRestore()
    }
    expect(logs.join('\n')).toContain(`recoverable: orch continue ${root}`)
  })

  test('result on an asking run succeeds, prints its reply, and points to the inbox', () => {
    const id = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    const output = join(dir, `asking-${id}.txt`)
    writeFileSync(output, 'partial answer')
    db().query('UPDATE run SET output_path=? WHERE id=?').run(output, id)
    db()
      .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which?')
    const logs: string[] = []
    const errors: string[] = []
    const log = spyOn(console, 'log').mockImplementation((...parts) => {
      logs.push(parts.join(' '))
    })
    const error = spyOn(console, 'error').mockImplementation((...parts) => {
      errors.push(parts.join(' '))
    })
    try {
      collectResult(db(), ['result', String(id)])
      expect(logs.join('\n')).toContain('partial answer')
      expect(errors.join('\n')).toContain(`orch answer ${id}`)
    } finally {
      log.mockRestore()
      error.mockRestore()
      rmSync(output, { force: true })
    }
  })

  test('result surfaces the recorded base commit for a writing run', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET base_commit=? WHERE id=?').run('base-commit-123', id)
    const errors: string[] = []
    const error = spyOn(console, 'error').mockImplementation((...parts) => {
      errors.push(parts.join(' '))
    })
    try {
      collectResult(db(), ['result', String(id)])
    } finally {
      error.mockRestore()
    }
    expect(errors.join('\n')).toContain('base:      base-commit-123')
  })

  test('a failed run wraps partial JSON so it cannot parse as a completed review', () => {
    const id = addRun({ agent: 'codex', job: 'review-lens', status: 'failed' })
    const output = join(dir, `failed-partial-${id}.txt`)
    const partial = { findings: [], provenance: { tree_inspected: 'two invalidators' } }
    writeFileSync(output, JSON.stringify(partial))
    db()
      .query(
        "UPDATE run SET output_path=?,error='agent died',failure_kind='interrupted',exit_code=1 WHERE id=?",
      )
      .run(output, id)
    const logs: string[] = []
    const log = spyOn(console, 'log').mockImplementation((...parts) => {
      logs.push(parts.join(' '))
    })
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`)
    }) as never)
    try {
      expect(() => collectResult(db(), ['result', String(id)])).toThrow('EXIT:1')
      const shown = JSON.parse(logs.join('\n'))
      expect(shown.run).toMatchObject({ id, status: 'failed', complete: false })
      expect(shown.findings).toBeUndefined()
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(partial)
    } finally {
      log.mockRestore()
      exit.mockRestore()
      rmSync(output, { force: true })
    }
  })

  test('waiting on a failed run exits non-zero', async () => {
    const id = addRun({ agent: 'codex', job: 'implement', status: 'failed' })
    db()
      .query(
        "UPDATE run SET error='worktree creation failed',failure_kind='harness',exit_code=17 WHERE id=?",
      )
      .run(id)
    const logs: string[] = []
    const log = spyOn(console, 'log').mockImplementation((...parts) => {
      logs.push(parts.join(' '))
    })
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`)
    }) as never)
    try {
      await expect(collectWait(db(), ['wait', String(id)])).rejects.toThrow('EXIT:1')
    } finally {
      log.mockRestore()
      exit.mockRestore()
    }
    expect(logs.join('\n')).toContain(`${id}\tfailed`)
    expect(logs.join('\n')).toContain('harness, exit 17: worktree creation failed')
  })

  test('orch result says so on the record a person would score from', () => {
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE id=?").run(id)
    expect(recordedResult(id).errors.join('\n')).toContain(
      'not routing evidence: shared an output file',
    )
  })

  test('orch result lists worker-filed notes and near-duplicate candidates', () => {
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    appendRunEvent(id, {
      ts: new Date().toISOString(),
      type: 'note',
      noteId: 71,
      candidateIds: [8, 13],
    })
    expect(recordedResult(id).errors.join('\n')).toContain('notes:     71 (near 8, 13)')
  })

  test('orch result exposes degradation and the explicit trust command', () => {
    const id = addRun({ agent: 'grok', job: 'review-lens' })
    db()
      .query(
        "UPDATE run SET cwd='/tmp/a lens tree',mcp=1,mcp_server='starship',mcp_connected=0,mcp_error='folder untrusted: repo-local server not started' WHERE id=?",
      )
      .run(id)
    const shown = recordedResult(id).errors.join('\n')
    expect(shown).toContain('mcp:       starship NOT CONNECTED')
    expect(shown).toContain("trust:     grok --cwd '/tmp/a lens tree' --trust")
  })

  test('orch result names an unverified attach distinctly from a confirmed one', () => {
    const unverified = addRun({ agent: 'codex', job: 'review-lens' })
    db()
      .query(
        "UPDATE run SET mcp=1,mcp_server='fixture-project',mcp_connected=NULL,mcp_error='codex does not expose an MCP connection diagnostic' WHERE id=?",
      )
      .run(unverified)
    const confirmed = addRun({ agent: 'grok', job: 'review-lens' })
    db()
      .query("UPDATE run SET mcp=1,mcp_server='fixture-project',mcp_connected=1 WHERE id=?")
      .run(confirmed)
    const unknown = recordedResult(unverified).errors.join('\n')
    const known = recordedResult(confirmed).errors.join('\n')
    expect(unknown).toContain('mcp:       fixture-project UNVERIFIED')
    expect(unknown).not.toContain('connected')
    expect(known).toContain('mcp:       fixture-project connected')
    expect(known).not.toContain('UNVERIFIED')
  })
})
