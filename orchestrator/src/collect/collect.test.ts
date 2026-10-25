import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { appendRunEvent, runEventsPath } from '../events.ts'
import {
  branchNote,
  collectResult,
  collectWait,
  collectWaitForRuns,
  mintedBranchForRun,
  noCommitNote,
  releasedWritingTreeNote,
  thinOutputWarning,
} from './collect.ts'

const recordedResult = (recordId: string, writingJob: () => boolean = () => false) => {
  const logs: string[] = []
  const errors: string[] = []
  collectResult(
    db(),
    ['result', recordId],
    () => '',
    {
      log: (...values) => logs.push(values.join(' ')),
      error: (...values) => errors.push(values.join(' ')),
      exit: (code): never => {
        throw new Error(`EXIT:${code}`)
      },
    },
    writingJob,
  )
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
    process.env.BOTTEGA_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT = output
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
      delete process.env.BOTTEGA_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('collection records', () => {
  test('result leaves an unparseable reply untouched and shows the observed disagreement', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    const output = join(dir, `unparseable-test-claim-${id}.txt`)
    const reply = '{"status":"done","tests":{"ran":true'
    try {
      writeFileSync(output, reply)
      db()
        .query(
          'UPDATE run SET output_path=?,tests_ran=0,tests_passed=NULL,tests_claim_disagrees=1 WHERE record_id=?',
        )
        .run(output, id)
      const shown = recordedResult(id)
      expect(shown.logs).toContain(reply)
      expect(shown.errors).toContain(
        'tests observed: {"ran":false,"passed":null}; tests_claim_disagrees: true',
      )
    } finally {
      rmSync(output, { force: true })
    }
  })

  test('result returns a stored writer reply from before change guides', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    const output = join(dir, `old-writer-reply-${id}.txt`)
    const oldReply = JSON.stringify({
      status: 'done',
      summary: 'stored before change guides',
      files_changed: ['old.ts'],
      questions: null,
      deviations: null,
      blockers: null,
      tests: null,
    })
    try {
      writeFileSync(output, oldReply)
      db().query('UPDATE run SET output_path=? WHERE record_id=?').run(output, id)
      expect(recordedResult(id).logs.join('\n')).toContain(oldReply)
    } finally {
      rmSync(output, { force: true })
    }
  })

  test('structured wait returns a failover chain terminal run and reads its output', async () => {
    const requestedId = addRun({ agent: 'codex', job: 'review-lens', status: 'failed' })
    const finalId = addRun({ agent: 'claude', job: 'review-lens' })
    db()
      .query('UPDATE run SET retry_of_record_id=?,automatic_failover=1 WHERE record_id=?')
      .run(requestedId, finalId)
    const output = join(dir, `structured-wait-${finalId}.txt`)
    writeFileSync(output, 'review result')
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(output, finalId)
    try {
      const result = await collectWaitForRuns(db(), [requestedId], { beforePoll: () => {} })
      expect(result).toMatchObject({
        kind: 'finished',
        runs: [
          {
            requestedId,
            finalId,
            status: 'ok',
            output: 'review result',
            error: null,
            exitCode: null,
          },
        ],
      })
    } finally {
      rmSync(output, { force: true })
    }
  })

  test('structured wait returns a failed terminal run without exiting', async () => {
    const id = addRun({ agent: 'codex', job: 'review-lens', status: 'failed' })
    db()
      .query(
        "UPDATE run SET error='harness refused',failure_kind='harness',exit_code=17 WHERE record_id=?",
      )
      .run(id)
    const result = await collectWaitForRuns(db(), [id], { beforePoll: () => {} })
    expect(result).toMatchObject({
      kind: 'finished',
      runs: [
        {
          finalId: id,
          status: 'failed',
          error: 'harness refused',
          exitCode: 17,
          ok: false,
        },
      ],
    })
  })

  test('structured wait returns a distinct timeout using an injected clock', async () => {
    const id = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    let now = 100
    const result = await collectWaitForRuns(db(), [id], {
      timeoutMs: 5,
      beforePoll: () => {},
      now: () => now,
      sleep: async () => {
        now += 5
      },
    })
    expect(result).toMatchObject({ kind: 'timed-out', runningIds: [id] })
  })

  test('a poll that sleeps does not read an output file', async () => {
    const id = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    const output = join(dir, `structured-wait-sleep-${id}.txt`)
    writeFileSync(output, 'partial review result')
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(output, id)
    let reads = 0
    let now = 100
    try {
      const result = await collectWaitForRuns(db(), [id], {
        timeoutMs: 5,
        beforePoll: () => {},
        now: () => now,
        sleep: async () => {
          expect(reads).toBe(0)
          now += 5
        },
        readOutput: (path) => {
          reads++
          return readFileSync(path, 'utf8')
        },
      })
      expect(result.kind).toBe('timed-out')
      expect(reads).toBe(1)
    } finally {
      rmSync(output, { force: true })
    }
  })

  test('dead-run callback fires once on first observation before a timeout', async () => {
    const dead = addRun({ agent: 'codex', job: 'review-lens', status: 'running' })
    const live = addRun({ agent: 'claude', job: 'review-lens', status: 'running' })
    const callbacks: string[] = []
    let polls = 0
    let now = 100
    const result = await collectWaitForRuns(db(), [dead, live], {
      timeoutMs: 5,
      beforePoll: () => {
        polls++
        return [{ record_id: dead, reason: 'process gone' }]
      },
      onObservedDead: (run) => callbacks.push(run.record_id),
      now: () => now,
      sleep: async () => {
        expect(callbacks).toEqual([dead])
        now += 5
      },
    })
    expect(polls).toBe(2)
    expect(callbacks).toEqual([dead])
    expect(result).toMatchObject({
      kind: 'timed-out',
      runs: [
        { finalId: dead, observedDead: true },
        { finalId: live, observedDead: false },
      ],
      runningIds: [live],
    })
  })

  test('result shows an ok outcome note directly before the score hint', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    const number = (
      db().query('SELECT number FROM run WHERE record_id=?').get(id) as {
        number: number
      }
    ).number
    db().query('UPDATE run SET error=? WHERE record_id=?').run('this turn changed nothing', id)
    const shown = recordedResult(id).errors.join('\n')
    expect(shown).toContain(
      `— run ${number} · codex · 1.0s · vendor tokens not reported\n  this turn changed nothing\n  score it:`,
    )
  })

  test('result rendering is byte-identical when an ok run has no outcome note', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    const number = (
      db().query('SELECT number FROM run WHERE record_id=?').get(id) as {
        number: number
      }
    ).number
    const recordId = db()
      .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
      .get(id)!.record_id
    expect(recordedResult(id).errors).toEqual([
      `\n— run ${number} · codex · 1.0s · vendor tokens not reported\n  score it:  ${PLATFORM_SLUG} score ${id} <none|partial|full> [wrong|mixed|right] --note "..."\n  record_id: ${recordId}`,
    ])
  })

  test('a refusal hint quotes its first summary line and includes writing fidelity', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    const output = join(dir, `refused-${id}.txt`)
    writeFileSync(
      output,
      JSON.stringify({
        status: 'refused',
        summary: 'evidence at outcome.ts:4\nsecond line',
        files_changed: null,
        change_guide: null,
        questions: null,
        deviations: null,
        blockers: null,
        tests: null,
      }),
    )
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(output, id)
    try {
      const hint = recordedResult(id, () => true).errors.join('\n')
      expect(hint).toContain('refused: "evidence at outcome.ts:4"')
      expect(hint).toContain('correct with evidence: full right faithful')
    } finally {
      rmSync(output, { force: true })
    }
  })

  test.each([
    ['tree present', { writingRun: true, worktree: '/tmp/tree' }, ''],
    [
      'tree released',
      { writingRun: true, worktree: null },
      `\n  open tree:  ${PLATFORM_SLUG} tree open 42`,
    ],
    ['non-writing run', { writingRun: false, worktree: null }, ''],
  ])('%s controls the open-tree footer', (_name, facts, expected) => {
    expect(releasedWritingTreeNote(facts, '42')).toBe(expected)
  })

  test('--follow names the branch minted by a writing run', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET minted_branch=? WHERE record_id=?').run('feature/DEV-498', id)
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
    expect(errors.join('\n')).toContain(`score it:  ${PLATFORM_SLUG} score ${root}`)
    expect(errors.join('\n')).not.toContain(`score it:  ${PLATFORM_SLUG} score ${child}`)
  })

  test('result and wait name the branch actually minted for a writing run', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET minted_branch=? WHERE record_id=?').run('feature/minted', id)
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
    db().query('UPDATE run SET minted_branch=? WHERE record_id=?').run('root-owned', root)
    db()
      .query('UPDATE run SET branch=?,minted_branch=NULL WHERE record_id=?')
      .run('turn-branch', child)
    expect(mintedBranchForRun(db(), child)).toBe('turn-branch')
  })

  test('a root authored commit does not suppress the turn own no-commit warning', () => {
    const root = addRun({ agent: 'codex', job: 'implement' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db()
      .query(
        'UPDATE run SET branch=?,base_commit=?,branch_kept_tip=?,changed_paths=? WHERE record_id=?',
      )
      .run('root-branch', base, 'f'.repeat(40), changed, root)
    db()
      .query(
        'UPDATE run SET branch=?,base_commit=?,branch_kept_tip=?,changed_paths=? WHERE record_id=?',
      )
      .run('turn-branch', base, base, changed, child)

    const note = branchNote(db(), child)
    expect(note).toContain('branch:    turn-branch')
    expect(note).toContain('no commit authored')
  })

  test('waiting on ok and asking runs succeeds and points to the inbox', async () => {
    const ok = addRun({ agent: 'codex', job: 'file-question' })
    const asking = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
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
    expect(logs.join('\n')).toContain(`${asking}\tasking - ${PLATFORM_SLUG} question inbox`)
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
    expect(logs.every((line) => line.split('\t')[0] !== '300')).toBe(true)
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
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
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
    expect(logs.join('\n')).toContain(`${PLATFORM_SLUG} question answer ${root}`)
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
    expect(logs.join('\n')).toContain(`recoverable: ${PLATFORM_SLUG} run continue ${root}`)
  })

  test('result on an asking run succeeds, prints its reply, and points to the inbox', () => {
    const id = addRun({ agent: 'codex', job: 'file-question', status: 'asking' })
    const output = join(dir, `asking-${id}.txt`)
    writeFileSync(output, 'partial answer')
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(output, id)
    db()
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,?,?)`,
      )
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
      expect(errors.join('\n')).toContain(`${PLATFORM_SLUG} question answer ${id}`)
    } finally {
      log.mockRestore()
      error.mockRestore()
      rmSync(output, { force: true })
    }
  })

  test('result surfaces the recorded base commit for a writing run', () => {
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET base_commit=? WHERE record_id=?').run('base-commit-123', id)
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
        "UPDATE run SET output_path=?,error='agent died',failure_kind='interrupted',exit_code=1 WHERE record_id=?",
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
      expect(shown.run).toMatchObject({ record_id: id, status: 'failed', complete: false })
      expect(shown.run.record_id).toBe(id)
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
        "UPDATE run SET error='worktree creation failed',failure_kind='harness',exit_code=17 WHERE record_id=?",
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

  test(`${PLATFORM_SLUG} run result says so on the record a person would score from`, () => {
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    db().query("UPDATE run SET evidence_excluded='shared an output file' WHERE record_id=?").run(id)
    expect(recordedResult(id).errors.join('\n')).toContain(
      'not routing evidence: shared an output file',
    )
  })

  test(`${PLATFORM_SLUG} run result ignores legacy numeric note events`, () => {
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    const eventsPath = runEventsPath(id)
    mkdirSync(dirname(eventsPath), { recursive: true })
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ ts: new Date().toISOString(), type: 'note', noteId: 71, candidateIds: [8, 13] })}\n`,
    )
    expect(recordedResult(id).errors.join('\n')).not.toContain('notes:')
  })

  test(`${PLATFORM_SLUG} run result lists labels from new worker note events`, () => {
    const id = addRun({ agent: 'codex', job: 'review-lens' })
    appendRunEvent(id, {
      ts: new Date().toISOString(),
      type: 'note',
      noteRecordId: '01990000-0000-7000-8000-000000000071',
      noteLabel: 'workshop#71',
      candidates: [{ recordId: '01990000-0000-7000-8000-000000000008', label: 'workshop#8' }],
    })
    expect(recordedResult(id).errors.join('\n')).toContain(
      'notes:     workshop#71 (near workshop#8)',
    )
  })

  test(`${PLATFORM_SLUG} run result exposes degradation and the explicit trust command`, () => {
    const id = addRun({ agent: 'grok', job: 'review-lens' })
    db()
      .query(
        "UPDATE run SET cwd='/tmp/a lens tree',mcp=1,mcp_server='starship',mcp_connected=0,mcp_error='folder untrusted: repo-local server not started' WHERE record_id=?",
      )
      .run(id)
    const shown = recordedResult(id).errors.join('\n')
    expect(shown).toContain('mcp:       starship NOT CONNECTED')
    expect(shown).toContain("trust:     grok --cwd '/tmp/a lens tree' --trust")
  })

  test(`${PLATFORM_SLUG} run result names an unverified attach distinctly from a confirmed one`, () => {
    const unverified = addRun({ agent: 'codex', job: 'review-lens' })
    db()
      .query(
        "UPDATE run SET mcp=1,mcp_server='fixture-project',mcp_connected=NULL,mcp_error='codex does not expose an MCP connection diagnostic' WHERE record_id=?",
      )
      .run(unverified)
    const confirmed = addRun({ agent: 'grok', job: 'review-lens' })
    db()
      .query("UPDATE run SET mcp=1,mcp_server='fixture-project',mcp_connected=1 WHERE record_id=?")
      .run(confirmed)
    const unknown = recordedResult(unverified).errors.join('\n')
    const known = recordedResult(confirmed).errors.join('\n')
    expect(unknown).toContain('mcp:       fixture-project UNVERIFIED')
    expect(unknown).not.toContain('connected')
    expect(known).toContain('mcp:       fixture-project connected')
    expect(known).not.toContain('UNVERIFIED')
  })
})
