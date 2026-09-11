// Tests run.ts: resumed conversation execution.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, createWorktree, db, dir, hermeticGitEnv, nowIso, runJob, workerReply } from '../test/fixture.ts'
import { scriptedTransportSequence } from '../test/fake-transport.ts'
describe('a conversation is one unit of work, not one per turn', () => {
  test('a three-turn chain resolves the intermediate asking turn end to end', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-three-turn-'))
    const promptPath = join(dir, `three-turn-${Math.random().toString(16).slice(2)}.prompt.txt`)
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    for (const args of [['init'], ['add', 'seed.txt']]) {
      const p = Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    const committed = Bun.spawnSync([
      'git', '-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid',
      'commit', '-m', 'seed',
    ], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (committed.exitCode !== 0) throw new Error(committed.stderr.toString())
    const tree = createWorktree(repo, 137)

    const priorDepth = process.env.ORCH_DEPTH
    process.env.ORCH_DEPTH = '0'
    scriptedTransportSequence([[
      { kind: 'completed', output: JSON.stringify(workerReply({
        status: 'asking', summary: 'need a second ruling', files_changed: null,
        questions: [{
          question: 'second question?', options: ['one', 'two'], recommendation: 'one',
          why: 'the ruling changes the implementation',
        }],
      })) },
    ], [
      { kind: 'completed', output: JSON.stringify(workerReply()) },
    ]]).install()

    const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    writeFileSync(promptPath, 'original implementation spec')
    db().query('UPDATE run SET prompt_path=? WHERE id=?').run(promptPath, root)
    db().query(
      `INSERT INTO question (run_id, asked_at, question, answer, answered_at)
       VALUES (?,?,?,?,?)`,
    ).run(root, nowIso(), 'first question?', 'first ruling', nowIso())

    try {
      const second = await runJob({
        job: 'implement', prompt: 'continue', cwd: tree.path,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 2,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })
      expect(second.status).toBe('asking')
      const question = db().query('SELECT id FROM question WHERE run_id=?').get(second.id) as { id: number }
      db().query('UPDATE question SET answer=?, answered_at=? WHERE id=?')
        .run('second ruling', nowIso(), question.id)

      const third = await runJob({
        job: 'implement', prompt: 'finish', cwd: tree.path,
        resume: {
          parent: root, agent: 'codex', session: 'test-session', turn: 3,
          sessionId: 'orch-test-session', worktree: tree,
        },
      })

      expect(db().query(
        'SELECT turn, status FROM run WHERE id=? OR parent_run_id=? ORDER BY turn',
      ).all(root, root)).toEqual([
        { turn: 1, status: 'ok' },
        { turn: 2, status: 'ok' },
        { turn: 3, status: 'ok' },
      ])
      expect(third.status).toBe('ok')
    } finally {
      if (priorDepth === undefined) delete process.env.ORCH_DEPTH
      else process.env.ORCH_DEPTH = priorDepth
      rmSync(repo, { recursive: true, force: true })
      rmSync(promptPath, { force: true })
    }
  })

})
