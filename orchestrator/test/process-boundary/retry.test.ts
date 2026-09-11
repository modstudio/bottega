import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, dir, runCollectionDescribeFixture, upsertProject } from '../fixture.ts'

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
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\necho ok\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    try {
      const retried = orchInput(['retry', String(child), '--agent', 'grok'], undefined, {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
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
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\nexit 99\n')
    chmodSync(join(binDir, 'codex'), 0o755)
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
})
