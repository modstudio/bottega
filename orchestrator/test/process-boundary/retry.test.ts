import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { READONLY_PREAMBLE, db, dir, replyFileInstruction, runCollectionDescribeFixture, upsertProject } from '../fixture.ts'
import { stubWorker } from "../stub-worker.ts"
import './retry.test-residue.ts'

// Retry delivery crosses the detach: the observable effect is the replacement
// child's prompt on disk after a real orch child ran. That is the process
// boundary, so these two stay here rather than beside run-answer.
describe('retry process boundary', () => {
  const { orchInput, orch, insert } = runCollectionDescribeFixture()

  test('retry through a child delivers a pending ruling from a non-asking stranded root', () => {
    const root = insert('failed', 'file-question')
    const child = insert('failed', 'file-question')
    const prompt = join(dir, `failed-stranded-${child}.prompt.txt`)
    writeFileSync(prompt, 'original failed fixture spec')
    db().query('UPDATE run SET session_id=? WHERE id=?').run('orch-test-session', root)
    db().query('UPDATE run SET parent_run_id=?, turn=2, prompt_path=?, cwd=? WHERE id=?')
      .run(root, prompt, dir, child)
    db().query(
      `INSERT INTO question
        (run_id, asked_at, question, answer, answered_at, answered_by, delivery_pending_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      child, new Date().toISOString(), 'which recovery?', 'retry with the recorded ruling',
      new Date().toISOString(), 'orch-test-session', new Date().toISOString(),
    )
    expect(db().query('SELECT delivery_pending_at FROM question WHERE run_id=?').get(child))
      .toEqual({ delivery_pending_at: expect.any(String) })

    const binDir = mkdtempSync(join(tmpdir(), 'orch-failed-stranded-retry-'))
    symlinkSync(stubWorker(), join(binDir, 'grok'))
    try {
      const retried = orchInput(['retry', String(child), '--agent', 'grok'], undefined, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`, ORCH_STUB_OUTPUT: 'ok',
      })
      expect(retried.code, retried.err).toBe(0)
      const replacement = db().query('SELECT prompt_path FROM run WHERE retry_of=?').get(child) as
        { prompt_path: string }
      const resent = readFileSync(replacement.prompt_path, 'utf8')
      expect(resent).toContain('YOU ASKED: which recovery?')
      expect(resent).toContain('THE RULING: retry with the recorded ruling')
      expect(db().query('SELECT delivery_pending_at FROM question WHERE run_id=?').get(child))
        .toEqual({ delivery_pending_at: null })
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('a recorded-ruling writing retry warns that prior partial edits are not carried', () => {
    const id = insert('asking', 'implement')
    const prompt = join(dir, `record-only-writing-${id}.prompt.txt`)
    writeFileSync(prompt, 'original implementation spec')
    upsertProject({
      name: PLATFORM_SLUG, path: process.cwd(),
      settings: { worktree: { recipe: {}, branch: '{key}-orch-{id}' } },
    })
    db().query('UPDATE run SET session_id=?, vendor_session=?, prompt_path=?, cwd=? WHERE id=?')
      .run('orch-test-session', 'valid-session', prompt, process.cwd(), id)
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(id, new Date().toISOString(), 'which shape?')
    expect(orch('answer', String(id), '--record-only', 'use the existing shape').code).toBe(0)

    const binDir = mkdtempSync(join(tmpdir(), 'orch-writing-warning-retry-'))
    symlinkSync(stubWorker({ exitCode: 99 }), join(binDir, 'codex'))
    try {
      const retried = orchInput(['retry', String(id)], undefined, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      })
      expect(retried.code).toBe(1)
      expect(retried.err).toContain(
        'recorded rulings require a fresh worktree; retry will not carry the previous partial edit',
      )
      expect(retried.err).toContain(
        "this project's branch names must carry a ticket key ({key}-orch-{id})",
      )
      expect((db().query('SELECT COUNT(*) n FROM run WHERE retry_of=?').get(id) as { n: number }).n)
        .toBe(0)
    } finally {
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  test('prefer persists through read-only retry and the bound prompt contains the preamble once', () => {
    const original = 'What does bar.ts do?'; const promptPath = join(dir, 'retry-original.prompt.txt'); writeFileSync(promptPath, original)
    const schemaPath = join(dir, 'retry-schema.json'); writeFileSync(schemaPath, JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }))
    const id = insert('failed', 'file-question'); db().query("UPDATE run SET agent='grok',prompt_path=?,mcp=2,mcp_error='mirror: original attach failed',schema_path=?,model='retry-model',cwd=? WHERE id=?").run(promptPath, schemaPath, dir, id)
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-grok-retry-')); symlinkSync(stubWorker(), join(binDir, 'grok'))
    try {
      const result = orchInput(['retry', String(id)], undefined, { PATH: `${binDir}:${process.env.PATH ?? ''}`, ORCH_STUB_REPLY: '{"answer":"ok"}', ORCH_STUB_OUTPUT: 'ok' }); expect(result.code, result.err).toBe(0)
      const child = db().query('SELECT prompt_path,mcp,schema_path,model,retry_of,agent FROM run WHERE retry_of=?').get(id) as { prompt_path: string; mcp: number; schema_path: string; model: string; retry_of: number; agent: string }
      expect(child).toMatchObject({ mcp: 2, schema_path: schemaPath, model: 'retry-model', retry_of: id, agent: 'grok' }); expect(readFileSync(child.prompt_path, 'utf8')).toBe(original)
      const bound = readFileSync(child.prompt_path.replace(/\.prompt\.txt$/, '.bound.txt'), 'utf8'); expect(bound.split(READONLY_PREAMBLE)).toHaveLength(2); expect(bound.startsWith(replyFileInstruction('retry-schema.json'))).toBe(true); expect(bound.endsWith(original)).toBe(true)
    } finally { rmSync(binDir, { recursive: true, force: true }) }
  })

  test('retry of an implement run continues its session detached and prints the child id', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'orch-fake-codex-retry-')); symlinkSync(stubWorker(), join(binDir, 'codex'))
    const id = insert('failed', 'implement'); db().query("UPDATE run SET vendor_session='retry-session',cwd=? WHERE id=?").run(dir, id)
    try {
      const result = orchInput(['retry', String(id)], undefined, { PATH: `${binDir}:${process.env.PATH ?? ''}`, FORCE_COLOR: '1' }); expect(result.code, result.err).toBe(0)
      const childId = Number(result.out.trim().split('\n')[0]); expect(childId).toBeGreaterThan(0); orch('wait', String(childId), '--timeout', '15')
      expect(db().query('SELECT parent_run_id,turn,vendor_session FROM run WHERE id=?').get(childId)).toEqual({ parent_run_id: id, turn: 2, vendor_session: 'retry-session' })
    } finally { rmSync(binDir, { recursive: true, force: true }) }
  }, 45_000)
})
