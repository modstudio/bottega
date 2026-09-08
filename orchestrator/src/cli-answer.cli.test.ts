import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARGV_PROMPT_BYTES, addRun, db, dir, packResumePrompt, packedResumePrompt, recordReview, reviewReply, rulingPrompt } from '../test/fixture.ts'

import { runCollectionDescribeFixture } from '../test/fixture.ts'

describe("detached run collection", () => {
  const { CLI, orchInput, orch, insert } = runCollectionDescribeFixture()
test('answer refuses six individually-legal --file rulings whose packed resume exceeds argv', () => {
    const id = insert('asking', 'implement')
    const spec = join(dir, `answer-six-large-${id}.prompt.txt`)
    writeFileSync(spec, 'original implementation spec')
    db().query('UPDATE run SET vendor_session=?, prompt_path=? WHERE id=?')
      .run('parent-session', spec, id)
    const now = new Date().toISOString()
    const body = 'x'.repeat(190_000)
    for (let i = 1; i <= 6; i++) {
      db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
        .run(id, now, `q${i}?`)
    }
    const questions = db().query(
      'SELECT id, question FROM question WHERE run_id=? ORDER BY id',
    ).all(id) as { id: number; question: string }[]
    const args: string[] = ['answer', String(id)]
    for (const q of questions) {
      const path = join(dir, `answer-six-large-${id}-q${q.id}.txt`)
      writeFileSync(path, body)
      args.push(`--q${q.id}`, '--file', path)
    }
    const packed = packedResumePrompt(
      'implement',
      rulingPrompt(questions.map((q) => ({ question: q.question, answer: body }))),
      id,
    )
    const assembled = Buffer.byteLength(packed, 'utf8')

    const r = orch(...args)

    expect(assembled).toBeGreaterThan(ARGV_PROMPT_BYTES)
    expect(r.code).toBe(1)
    expect(r.err).toContain(`assembled resume prompt is ${assembled} bytes`)
    expect(r.err).toContain(`bounded at ${ARGV_PROMPT_BYTES} bytes`)
    expect(r.err).toContain('rulings that would need to shrink:')
    expect(r.err).toContain('nothing was stored')
    for (const q of questions) {
      expect(r.err).toContain(`--q${q.id} (${Buffer.byteLength(body, 'utf8')} bytes)`)
      expect((db().query('SELECT answer FROM question WHERE id=?').get(q.id) as
        { answer: string | null }).answer).toBeNull()
    }
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(id) as
      { n: number }).n).toBe(0)
  })

  test('answer accepts six small --file rulings and resumes', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-six-small-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const id = insert('asking', 'implement')
    const spec = join(dir, `answer-six-small-${id}.prompt.txt`)
    writeFileSync(spec, 'original implementation spec')
    db().query('UPDATE run SET vendor_session=?, prompt_path=? WHERE id=?')
      .run('parent-session', spec, id)
    const now = new Date().toISOString()
    for (let i = 1; i <= 6; i++) {
      db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
        .run(id, now, `q${i}?`)
    }
    const questions = db().query(
      'SELECT id FROM question WHERE run_id=? ORDER BY id',
    ).all(id) as { id: number }[]
    const args: string[] = ['answer', String(id)]
    try {
      for (const q of questions) {
        const path = join(dir, `answer-six-small-${id}-q${q.id}.txt`)
        writeFileSync(path, `yes ${q.id}`)
        args.push(`--q${q.id}`, '--file', path)
      }
      const r = orchInput(args, undefined, { PATH: `${binDir}:${process.env.PATH ?? ''}` })
      expect(r.code).toBe(0)
      expect(r.out).toContain(`resumed run ${id} as run`)
      for (const q of questions) {
        expect((db().query('SELECT answer FROM question WHERE id=?').get(q.id) as
          { answer: string }).answer).toBe(`yes ${q.id}`)
      }
      const childId = Number(r.out.replace(/\u001B\[[0-9;]*m/g, '').match(/as run (\d+)/)?.[1])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)

  test('answer refuses questions split between live and stopped owners', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({
      agent: 'codex', job: 'implement', status: 'running', parent: root, turn: 2,
    })
    db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, child)
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    const insertQuestion = db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    )
    insertQuestion.run(root, new Date().toISOString(), 'root question?')
    insertQuestion.run(child, new Date().toISOString(), 'child question?')

    const r = orch('answer', String(root), 'one', 'two')

    expect(r.code).toBe(1)
    expect(r.err).toContain('both live and stopped turns')
    expect(r.err).toContain(`run ${child}, running`)
    expect(r.err).toContain(`run ${root}, asking`)
    expect((db().query(
      'SELECT COUNT(*) n FROM question WHERE answered_at IS NOT NULL',
    ).get() as { n: number }).n).toBe(0)
  })

  test('a stopped run without a vendor session keeps its question open', () => {
    const id = insert('stopped', 'implement')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'still answerable?')

    const r = orch('answer', String(id), 'yes')
    expect(r.code).toBe(1)
    expect(r.err).toContain('invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned')
    expect(r.err).toContain(`orch retry ${id} --agent <name>`)
    expect(r.err).toContain(`orch abandon ${id}`)
    expect(r.err).not.toContain('the ruling was NOT recorded')
    expect(db().query(
      'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
    ).get(id)).toEqual({ answer: null, answered_by: null, answered_at: null })
  })

  test('answer refuses a terminal or voided chain without writing', () => {
    const cases: { status: string; excluded: string | null }[] = [
      { status: 'failed', excluded: null },
      { status: 'stopped', excluded: null },
      { status: 'stale', excluded: null },
      { status: 'asking', excluded: 'voided with orch score --void' },
    ]
    for (const { status, excluded } of cases) {
      const id = addRun({ agent: 'missing-test-agent', job: 'implement', status })
      db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', id)
      if (excluded !== null) {
        db().query('UPDATE run SET evidence_excluded=? WHERE id=?').run(excluded, id)
      }
      db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
        .run(id, new Date().toISOString(), `${status} question?`)

      const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
      const result = orch('answer', String(id), `${status} ruling`)
      expect(result.code).toBe(1)
      expect(result.err).toContain(
        'invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned',
      )
      expect(result.err).toContain(`orch retry ${id} --agent <name>`)
      expect(result.err).toContain(`orch abandon ${id}`)
      expect(result.out).not.toContain(`resumed run ${id} as run`)
      expect(db().query(
        'SELECT answer, answered_by, answered_at FROM question WHERE run_id=?',
      ).get(id)).toEqual({ answer: null, answered_by: null, answered_at: null })
      expect(db().query(
        'SELECT action FROM run_mutation_audit WHERE run_id=?',
      ).all(id)).toEqual([])
      expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
    }
  })

  test('stopped roots resume while stale roots cannot claim another continuation turn', () => {
    for (const status of ['stopped', 'stale']) {
      const id = addRun({ agent: 'missing-test-agent', job: 'implement', status })
      db().query('UPDATE run SET session_id=?, vendor_session=? WHERE id=?')
        .run('orch-test-session', `${status}-vendor-session`, id)
      const before = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n

      const result = orch('continue', String(id), 'resume after lifecycle mutation')
      if (status === 'stopped') {
        expect(result.code).toBe(0)
        expect(Number(result.out.trim())).toBeGreaterThan(id)
        expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before + 1)
        expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(id))
          .toEqual([{ action: 'continue' }])
      } else {
        expect(result.code).toBe(1)
        expect(result.err).toContain(`run ${id} is stale and cannot be continued`)
        expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(before)
        expect(db().query('SELECT action FROM run_mutation_audit WHERE root_id=?').all(id)).toEqual([])
      }
    }
  })

  test('a findings root with a recorded review cannot be re-terminalised', () => {
    const root = addRun({
      agent: 'codex', job: 'review-lens', status: 'ok', lens: 'correctness',
      session: 'orch-test-session',
    })
    const reviewId = recordReview(root, reviewReply(1, 'high'))
    const before = db().query(
      `SELECT r.id, r.completed_at, rl.id lens_id, rl.run_id
         FROM review r JOIN review_lens rl ON rl.review_id=r.id WHERE r.id=?`,
    ).get(reviewId)
    const runCount = (db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n

    const result = orch('continue', String(root), 'review another turn')

    expect(result.code).toBe(1)
    expect(result.err).toContain("invariant: a recorded review is the run's product and is not re-terminalised")
    expect(result.err).toContain('cleared by: dispatch a new review run')
    expect((db().query('SELECT COUNT(*) n FROM run').get() as { n: number }).n).toBe(runCount)
    expect(db().query(
      `SELECT r.id, r.completed_at, rl.id lens_id, rl.run_id
         FROM review r JOIN review_lens rl ON rl.review_id=r.id WHERE r.id=?`,
    ).get(reviewId)).toEqual(before)
  })

  test('result on a still-running run exits 2, not 1', () => {
    // A poller must be able to tell "wait longer" from "stop waiting"; one exit
    // code for both would make a fan-out give up on its own runs.
    const id = insert('running')
    const r = orch('result', String(id))
    expect(r.code).toBe(2)
    expect(r.err).toContain('still running')
  })

  test('result on an unknown run says so rather than exiting 2', () => {
    expect(orch('result', '999999').code).toBe(1)
  })

  test('continue falls back to the chain\'s newest session when the latest turn has none', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('ok', 'file-question')
    const prompt = join(dir, `continue-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original research spec')
    db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
      .run('parent-session', 'codex', prompt, root)
    const stale = insert('stale', 'file-question')
    db().query(
      'UPDATE run SET parent_run_id=?, turn=?, vendor_session=NULL, agent=? WHERE id=?',
    ).run(root, 2, 'grok', stale)
    try {
      const r = Bun.spawnSync(
        [process.execPath, CLI, 'continue', String(root), 'finish'],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const out = typeof r.stdout === 'string' ? r.stdout : new TextDecoder().decode(r.stdout)
      const err = typeof r.stderr === 'string' ? r.stderr : new TextDecoder().decode(r.stderr)
      expect(r.exitCode).toBe(0)
      expect(err).toContain(`newest turn ${stale} recorded no session id`)
      expect(err).toContain(`resuming codex with the session from run ${root} (turn 1)`)
      const childId = Number(out.replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const child = db().query(
        'SELECT status, parent_run_id, agent, vendor_session FROM run WHERE id=?',
      ).get(childId) as
        { status: string; parent_run_id: number | null; agent: string; vendor_session: string | null } | null
      expect(child?.status).not.toBe('running')
      expect(child?.parent_run_id).toBe(root)
      expect(child?.agent).toBe('codex')
      expect(child?.vendor_session).toBe('parent-session')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)

  test('a checkpoint continues in a fresh vendor turn with or without a recorded session', () => {
    for (const vendorSession of [null, 'old-session']) {
      const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-checkpoint-'))
      const argv = join(binDir, 'argv.txt')
      writeFileSync(join(binDir, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\nexit 0\n`)
      chmodSync(join(binDir, 'codex'), 0o755)
      const root = insert('ok', 'file-question')
      const prompt = join(dir, `checkpoint-root-${root}.prompt.txt`)
      writeFileSync(prompt, 'the root checkpoint spec')
      db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
        .run(vendorSession, 'codex', prompt, root)
      db().query(
        `INSERT INTO run_checkpoint (run_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
         VALUES (?,1,?,'item 1',1,?)`,
      ).run(root, 'a'.repeat(40), new Date().toISOString())
      try {
        const r = orchInput(
          ['continue', String(root), 'caller follow-up'], undefined,
          { PATH: `${binDir}:${process.env.PATH ?? ''}` },
        )
        expect(r.code, r.err).toBe(0)
        const childId = Number(r.out.replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
        orch('wait', String(childId), '--timeout', '15')
        const launched = readFileSync(argv, 'utf8')
        expect(launched).not.toContain('resume')
        const child = db().query(
          'SELECT parent_run_id,turn,vendor_session,prompt_path FROM run WHERE id=?',
        ).get(childId) as {
          parent_run_id: number; turn: number; vendor_session: string | null; prompt_path: string
        }
        expect(child.parent_run_id).toBe(root)
        expect(child.turn).toBe(2)
        expect(child.vendor_session).not.toBe('old-session')
        const sent = readFileSync(child.prompt_path, 'utf8')
        expect(sent).toContain('CHECKPOINT RESUME')
        expect(sent).toContain('the root checkpoint spec')
        expect(sent).toContain('caller follow-up')
      } finally {
        rmSync(binDir, { recursive: true, force: true })
      }
    }
  }, 45_000)

  test('continue --file reads the follow-up without shell interpolation', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-continue-file-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('ok', 'file-question')
    const prompt = join(dir, `continue-file-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original research spec')
    db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
      .run('parent-session', 'codex', prompt, root)
    const path = join(dir, `continue-file-${root}.txt`)
    const body = 'Next: keep `literal` and $(hostname) byte-for-byte.\n'
    writeFileSync(path, body)
    try {
      const r = Bun.spawnSync(
        [process.execPath, CLI, 'continue', String(root), '--file', path],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const out = typeof r.stdout === 'string' ? r.stdout : new TextDecoder().decode(r.stdout)
      const err = typeof r.stderr === 'string' ? r.stderr : new TextDecoder().decode(r.stderr)
      expect(r.exitCode).toBe(0)
      expect(err).not.toContain('unrecognised argument')
      const childId = Number(out.replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const child = db().query(
        'SELECT prompt_path, parent_run_id FROM run WHERE id=?',
      ).get(childId) as { prompt_path: string; parent_run_id: number | null }
      expect(child.parent_run_id).toBe(root)
      expect(readFileSync(child.prompt_path, 'utf8')).toBe(body)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)

  test('continue refuses a follow-up that is only --file', () => {
    const root = insert('ok', 'file-question')
    db().query('UPDATE run SET vendor_session=? WHERE id=?').run('parent-session', root)
    const path = join(dir, `continue-dash-token-${root}.txt`)
    writeFileSync(path, '--file')
    const r = orch('continue', String(root), '--file', path)
    expect(r.code).toBe(1)
    expect(r.err).toContain('received "--file" as a message')
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root) as
      { n: number }).n).toBe(0)
  })

  test('continue accepts a two-word follow-up beginning with --', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-continue-dash-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('ok', 'file-question')
    const prompt = join(dir, `continue-dash-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original research spec')
    db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
      .run('parent-session', 'codex', prompt, root)
    try {
      const r = Bun.spawnSync(
        [process.execPath, CLI, 'continue', String(root), '--literal is intended'],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const out = typeof r.stdout === 'string' ? r.stdout : new TextDecoder().decode(r.stdout)
      expect(r.exitCode).toBe(0)
      const childId = Number(out.replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const child = db().query('SELECT prompt_path FROM run WHERE id=?').get(childId) as
        { prompt_path: string }
      expect(readFileSync(child.prompt_path, 'utf8')).toBe('--literal is intended')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)

  test('continue --file refuses a NUL and names the byte offset', () => {
    const root = insert('ok', 'file-question')
    db().query('UPDATE run SET vendor_session=?, agent=? WHERE id=?')
      .run('parent-session', 'codex', root)
    const path = join(dir, `continue-nul-${root}.bin`)
    writeFileSync(path, Buffer.from('A\0B'))
    const r = orch('continue', String(root), '--file', path)
    expect(r.code).toBe(1)
    expect(r.err).toContain('NUL at byte offset 1')
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root) as
      { n: number }).n).toBe(0)
  })

  test('continue --file refuses a prompt above the argv resume bound', () => {
    const root = insert('ok', 'file-question')
    db().query('UPDATE run SET vendor_session=?, agent=? WHERE id=?')
      .run('parent-session', 'codex', root)
    const path = join(dir, `continue-huge-${root}.txt`)
    const bytes = 1024 * 1024
    writeFileSync(path, 'A'.repeat(bytes))
    const r = orch('continue', String(root), '--file', path)
    expect(r.code).toBe(1)
    expect(r.err).toContain(`${bytes} bytes`)
    expect(r.err).toContain(`bounded at ${ARGV_PROMPT_BYTES} bytes`)
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root) as
      { n: number }).n).toBe(0)
  })

  test('continue --file refuses when a just-below-limit body plus the reminder exceeds argv', () => {
    const root = insert('ok', 'file-question')
    const longSpec = 's'.repeat(600)
    const shortSpec = 'x'
    const shortOverhead = Buffer.byteLength(packResumePrompt('file-question', '', shortSpec), 'utf8')
    const body = 'A'.repeat(ARGV_PROMPT_BYTES - shortOverhead)
    const spec = join(dir, `continue-assembled-long-${root}.prompt.txt`)
    writeFileSync(spec, longSpec)
    db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
      .run('parent-session', 'codex', spec, root)
    const path = join(dir, `continue-assembled-long-${root}.txt`)
    writeFileSync(path, body)
    const assembled = Buffer.byteLength(packResumePrompt('file-question', body, longSpec), 'utf8')
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(ARGV_PROMPT_BYTES)
    expect(assembled).toBeGreaterThan(ARGV_PROMPT_BYTES)

    const r = orch('continue', String(root), '--file', path)
    expect(r.code).toBe(1)
    expect(r.err).toContain(`assembled resume prompt is ${assembled} bytes`)
    expect(r.err).toContain(`bounded at ${ARGV_PROMPT_BYTES} bytes`)
    expect(r.err).toContain('nothing was stored')
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root) as
      { n: number }).n).toBe(0)
  })

  test('continue --file accepts the same body when the reminder is short', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-continue-short-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('ok', 'file-question')
    const shortSpec = 'x'
    const shortOverhead = Buffer.byteLength(packResumePrompt('file-question', '', shortSpec), 'utf8')
    const body = 'A'.repeat(ARGV_PROMPT_BYTES - shortOverhead)
    const spec = join(dir, `continue-assembled-short-${root}.prompt.txt`)
    writeFileSync(spec, shortSpec)
    db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
      .run('parent-session', 'codex', spec, root)
    const path = join(dir, `continue-assembled-short-${root}.txt`)
    writeFileSync(path, body)
    expect(Buffer.byteLength(packResumePrompt('file-question', body, shortSpec), 'utf8'))
      .toBeLessThanOrEqual(ARGV_PROMPT_BYTES)
    try {
      const r = orchInput(
        ['continue', String(root), '--file', path],
        undefined,
        { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      )
      expect(r.code).toBe(0)
      const childId = Number(r.out.replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const child = db().query(
        'SELECT prompt_path, parent_run_id FROM run WHERE id=?',
      ).get(childId) as { prompt_path: string; parent_run_id: number | null }
      expect(child.parent_run_id).toBe(root)
      expect(readFileSync(child.prompt_path, 'utf8')).toBe(body)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)

  test('continue --file refuses invalid UTF-8 at the byte offset', () => {
    const root = insert('ok', 'file-question')
    db().query('UPDATE run SET vendor_session=?, agent=? WHERE id=?')
      .run('parent-session', 'codex', root)
    const path = join(dir, `continue-bad-utf8-${root}.bin`)
    writeFileSync(path, Buffer.from([0x66, 0x80, 0xff, 0x67]))
    const r = orch('continue', String(root), '--file', path)
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid UTF-8')
    expect(r.err).toContain('byte offset 1')
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root) as
      { n: number }).n).toBe(0)
  })

  test('continue stdin refuses invalid UTF-8 at the byte offset', () => {
    const root = insert('ok', 'file-question')
    db().query('UPDATE run SET vendor_session=?, agent=? WHERE id=?')
      .run('parent-session', 'codex', root)
    const r = orchInput(['continue', String(root)], Buffer.from([0x66, 0x80, 0xff, 0x67]))
    expect(r.code).toBe(1)
    expect(r.err).toContain('invalid UTF-8')
    expect(r.err).toContain('byte offset 1')
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root) as
      { n: number }).n).toBe(0)
  })

  test('continue stdin refuses whitespace-only input instead of substituting the canned prompt', () => {
    const root = insert('ok', 'file-question')
    db().query('UPDATE run SET vendor_session=?, agent=? WHERE id=?')
      .run('parent-session', 'codex', root)
    const r = orchInput(['continue', String(root)], Buffer.from([0x20, 0x09, 0x0d, 0x0a]))
    expect(r.code).toBe(1)
    expect(r.err).toContain('empty message')
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root) as
      { n: number }).n).toBe(0)
  })

  test('continue stdin refuses an empty pipe instead of substituting the canned prompt', () => {
    const root = insert('ok', 'file-question')
    db().query('UPDATE run SET vendor_session=?, agent=? WHERE id=?')
      .run('parent-session', 'codex', root)
    const r = orchInput(['continue', String(root)], '')
    expect(r.code).toBe(1)
    expect(r.err).toContain('empty message')
    expect((db().query('SELECT COUNT(*) n FROM run WHERE parent_run_id=?').get(root) as
      { n: number }).n).toBe(0)
  })

  test('continue keeps flag-shaped words after the message starts', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-continue-quiet-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('ok', 'file-question')
    const prompt = join(dir, `continue-quiet-root-${root}.prompt.txt`)
    writeFileSync(prompt, 'original research spec')
    db().query('UPDATE run SET vendor_session=?, agent=?, prompt_path=? WHERE id=?')
      .run('parent-session', 'codex', prompt, root)
    try {
      const r = Bun.spawnSync(
        [process.execPath, CLI, 'continue', String(root), 'use', '--quiet', 'mode'],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'orch-test-session',
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const out = typeof r.stdout === 'string' ? r.stdout : new TextDecoder().decode(r.stdout)
      expect(r.exitCode).toBe(0)
      const childId = Number(out.replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0])
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const child = db().query('SELECT prompt_path FROM run WHERE id=?').get(childId) as
        { prompt_path: string }
      expect(readFileSync(child.prompt_path, 'utf8')).toBe('use --quiet mode')
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)

  test('continuing an unowned root adopts it before linking the child', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-adopt-'))
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    const root = insert('failed', 'implement')
    db().query(
      'UPDATE run SET session_id=NULL, vendor_session=?, agent=?, cwd=? WHERE id=?',
    ).run('unowned-vendor-session', 'codex', dir, root)
    try {
      const continued = Bun.spawnSync(
        [process.execPath, CLI, 'continue', String(root), 'continue adoption fixture'],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'session-A',
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(continued.exitCode).toBe(0)
      const childId = Number(
        continued.stdout.toString().replace(/\u001B\[[0-9;]*m/g, '').trim().split('\n')[0],
      )
      expect(childId).toBeGreaterThan(0)
      orch('wait', String(childId), '--timeout', '15')
      const child = db().query(
        'SELECT id, session_id FROM run WHERE id=?',
      ).get(childId) as { id: number; session_id: string | null } | null
      expect(child).not.toBeNull()
      expect(db().query('SELECT session_id FROM run WHERE id=?').get(root))
        .toEqual({ session_id: 'session-A' })
      expect(child!.session_id).toBe('session-A')
      expect(db().query(
        'SELECT action, actor_session, reason FROM run_mutation_audit WHERE root_id=? ORDER BY rowid',
      ).all(root)).toEqual([
        { action: 'adopt', actor_session: 'session-A', reason: 'before continue' },
        { action: 'continue', actor_session: 'session-A', reason: 'continue adoption fixture' },
      ])

      const stopped = Bun.spawnSync(
        [process.execPath, CLI, 'stop', String(child!.id)],
        {
          env: {
            ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
            CLAUDE_CODE_SESSION_ID: 'session-B',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(stopped.exitCode).toBe(1)
      expect(stopped.stderr.toString()).toContain(`run ${child!.id} is owned by session session-A`)
      expect(db().query('SELECT session_id FROM run WHERE id=?').get(root))
        .toEqual({ session_id: 'session-A' })
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  }, 45_000)
})
