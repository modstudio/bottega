import { describe,expect,spyOn,test } from 'bun:test'
import { mkdirSync,rmSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { reviewReply } from '../test/fixtures/replies.ts'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { upsertProject } from './projects.ts'
import { completeReview, gradeReviewLens, recordReview, recordReviews, triageFinding } from './review.ts'

describe('review discipline', () => {
test('records each lens before triage and derives runner and model from the orch run', () => {
    const first = addRun({ agent: 'codex', job: 'review-lens', model: 'effective-a', lens: 'safety' })
    const second = addRun({ agent: 'grok', job: 'craft', model: 'effective-b', lens: 'craft' })
    const review = recordReviews([
      { runId: first, output: reviewReply() }, { runId: second, output: reviewReply(0) },
    ])
    const rows = db().query(
      `SELECT rl.run_id, rl.lens, rl.agent, rl.model, r.completed_at
         FROM review_lens rl JOIN review r ON r.id=rl.review_id ORDER BY rl.run_id`,
    ).all() as { run_id: number; lens: string; agent: string; model: string; completed_at: string | null }[]
    expect(rows).toEqual([
      { run_id: first, lens: 'safety', agent: 'codex', model: 'effective-a', completed_at: null },
      { run_id: second, lens: 'craft', agent: 'grok', model: 'effective-b', completed_at: null },
    ])
    expect(() => completeReview(review)).toThrow('untriaged')
    triageFinding(review, 1, 'accepted')
    completeReview(review)
    expect(db().query('SELECT completed_at FROM review WHERE id=?').get(review) as
      { completed_at: string }).toHaveProperty('completed_at')
  })
test('records orch-measured trees, refuses mixed measured content, and keeps claims optional', () => {
    const tree = '1111111111111111111111111111111111111111'
    const first = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'one', inputTree: tree })
    const second = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'two', inputTree: tree })
    const withoutClaim = reviewReply(0)
    delete (withoutClaim.provenance as Partial<typeof withoutClaim.provenance>).tree_inspected
    const review = recordReviews([
      { runId: first, output: withoutClaim }, { runId: second, output: reviewReply(0) },
    ])
    expect(db().query(
      'SELECT tree_inspected, reviewed_tree FROM review_lens WHERE review_id=? ORDER BY id',
    ).all(review)).toEqual([
      { tree_inspected: null, reviewed_tree: tree },
      { tree_inspected: 'abc123', reviewed_tree: tree },
    ])

    const third = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'three',
      inputTree: '2222222222222222222222222222222222222222' })
    expect(() => recordReviews([
      { runId: third, output: reviewReply(0) },
      { runId: addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'four',
        inputTree: '3333333333333333333333333333333333333333' }), output: reviewReply(0) },
    ])).toThrow(`run ${third}: 2222222222222222222222222222222222222222`)
  })
test('an unregistered project warns after recording and does not block later grading', () => {
    const runId = addRun({
      agent: 'codex', job: 'review-lens', model: 'm', lens: 'unregistered-pin',
      repo: 'not-registered', headCommit: 'a'.repeat(40),
    })
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reviewId = recordReview(runId, reviewReply(0), db())
      expect(reviewId).toBeGreaterThan(0)
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
        `refs/orch/reviewed/${runId} was not created: project not-registered is not registered`,
      ))
      expect(() => gradeReviewLens(runId, null, {
        reproduced: 'none', coverage: 'adequate', limits: 'named', overlap: 'none',
      })).not.toThrow()
      expect(db().query('SELECT COUNT(*) AS n FROM review WHERE id=?').get(reviewId))
        .toEqual({ n: 1 })
    } finally { stderr.mockRestore() }
  })
test('an update-ref refusal warns after recording and does not block later grading', () => {
    const repo = cloneRepository('orch-review-pin-refusal-')
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim())
      return p.stdout.toString().trim()
    }
    const project = 'review-pin-refusal'
    upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
    const runId = addRun({
      agent: 'codex', job: 'review-lens', model: 'm', lens: 'refused-pin', repo: project,
      inputTree: runGit('rev-parse', 'HEAD^{tree}'), headCommit: runGit('rev-parse', 'HEAD'),
    })
    const refDir = join(repo, '.git', 'refs', 'orch', 'reviewed')
    mkdirSync(refDir, { recursive: true })
    writeFileSync(join(refDir, `${runId}.lock`), 'held\n')
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const reviewId = recordReview(runId, reviewReply(0), db())
      expect(reviewId).toBeGreaterThan(0)
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
        `refs/orch/reviewed/${runId} was not created: git update-ref failed:`,
      ))
      expect(() => runGit('rev-parse', `refs/orch/reviewed/${runId}`)).toThrow()
      expect(() => gradeReviewLens(runId, null, {
        reproduced: 'none', coverage: 'adequate', limits: 'absent', overlap: 'none',
      })).not.toThrow()
      expect(db().query('SELECT COUNT(*) AS n FROM review WHERE id=?').get(reviewId))
        .toEqual({ n: 1 })
    } finally {
      stderr.mockRestore()
      rmSync(repo, { recursive: true, force: true })
    }
  })
test('the grading capture path creates the same reviewed-commit pin', () => {
    const repo = cloneRepository('orch-review-grade-pin-')
    const runGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim())
      return p.stdout.toString().trim()
    }
    try {
      const project = 'review-grade-pin'
      upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
      const commit = runGit('rev-parse', 'HEAD')
      const runId = addRun({
        agent: 'codex', job: 'review-lens', model: 'm', lens: 'grade-pin', repo: project,
        inputTree: runGit('rev-parse', 'HEAD^{tree}'), headCommit: commit,
      })
      gradeReviewLens(runId, reviewReply(0), {
        reproduced: 'none', coverage: 'adequate', limits: 'named', overlap: 'none',
      })
      expect(runGit('rev-parse', `refs/orch/reviewed/${runId}`)).toBe(commit)
    } finally { rmSync(repo, { recursive: true, force: true }) }
  })
test('triage records explicit severity agreement and leaves omission unassessed', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'severity' })
    const reviewId = recordReview(runId, reviewReply(2), db())
    db().query("UPDATE review_finding SET severity='high' WHERE review_id=? AND ordinal=2")
      .run(reviewId)
    triageFinding(reviewId, 1, 'accepted', undefined, 'critical')
    triageFinding(reviewId, 2, 'modified', undefined, 'high')
    expect(db().query(
      'SELECT ordinal, severity, triaged_severity FROM review_finding WHERE review_id=? ORDER BY ordinal',
    ).all(reviewId)).toEqual([
      { ordinal: 1, severity: 'major', triaged_severity: 'critical' },
      { ordinal: 2, severity: 'high', triaged_severity: 'high' },
    ])
    expect(() => triageFinding(reviewId, 1, 'accepted', undefined, 'banana'))
      .toThrow('critical | high | medium | low')
    expect(() => db().query("UPDATE review_finding SET triaged_severity='banana' WHERE review_id=?")
      .run(reviewId)).toThrow()
  })
})

