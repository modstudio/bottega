import { describe, expect, test } from 'bun:test'
import { addRun } from '../test/fixtures/store.ts'
import { ask } from './ask.ts'
import { db } from './db.ts'
describe('the live ask channel always answers', () => {
  test('a live question is answerable through the command, not only in SQL', () => {
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    db().query(
      'INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)',
    ).run(live, new Date().toISOString(), 'which table?')
    const answerable = (id: number) => {
      const r = db().query('SELECT status, parent_run_id FROM run WHERE id = ?').get(id) as
        { status: string; parent_run_id: number | null }
      const open = db().query(
        `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
          WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
      ).get(id, id) as { n: number }
      return !r.parent_run_id && open.n > 0 && (r.status === 'running' || r.status === 'asking')
    }; expect(answerable(live)).toBe(true); expect(answerable(addRun({ agent: 'codex', job: 'implement', status: 'running' }))).toBe(false)
  })
  test('a question asked on turn two is answerable from the root', () => {
    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    const child = addRun({ agent: 'codex', job: 'implement', parent: root, turn: 2 })
    db().query('INSERT INTO question (run_id, asked_at, question) VALUES (?,?,?)')
      .run(child, new Date().toISOString(), 'and now what?')
    const open = db().query(
      `SELECT q.id FROM question q JOIN run r ON r.id = q.run_id
        WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
    ).all(root, root) as { id: number }[]; expect(open.length).toBe(1)
  })
  test('an unanswered question survives the timeout', async () => {
    const run = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    await ask({ runId: run, question: 'still open', timeoutMs: 50 })
    const open = db().query(
      'SELECT COUNT(*) AS n FROM question WHERE run_id = ? AND answered_at IS NULL',
    ).get(run) as { n: number }; expect(open.n).toBe(1)
  })
})
