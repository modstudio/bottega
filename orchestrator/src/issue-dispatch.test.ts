import { describe, expect, test } from 'bun:test'
import { addRun, score } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { unscoredFiledIssueLoopRuns } from './issue-dispatch.ts'

describe('unscored filed-issue loop runs', () => {
  test('lists terminal loop-started runs that have no verdict', () => {
    const diagnosis = addRun({ agent: 'codex', job: 'diagnose' })
    const fix = addRun({ agent: 'codex', job: 'issue-worker' })
    const lens = addRun({ agent: 'codex', job: 'review-lens' })
    const hand = addRun({ agent: 'codex', job: 'diagnose' })
    const judged = addRun({ agent: 'codex', job: 'diagnose' })
    const failed = addRun({ agent: 'codex', job: 'diagnose', status: 'failed' })
    db().query('UPDATE run SET label=? WHERE id=?').run('issue DEV-1 diagnosis', diagnosis)
    db().query('UPDATE run SET label=? WHERE id=?').run('issue DEV-1 fix', fix)
    db().query('UPDATE run SET label=? WHERE id=?').run('issue DEV-1 blast radius', lens)
    db().query('UPDATE run SET label=? WHERE id=?').run('hand-dispatched diagnosis', hand)
    db().query('UPDATE run SET label=? WHERE id=?').run('issue DEV-1 diagnosis', judged)
    db().query('UPDATE run SET label=? WHERE id=?').run('issue DEV-1 diagnosis', failed)
    score(judged, 'full', 'right')
    expect(unscoredFiledIssueLoopRuns()).toEqual([
      { runId: diagnosis, job: 'diagnose', issueKey: 'DEV-1' },
      { runId: fix, job: 'issue-worker', issueKey: 'DEV-1' },
      { runId: lens, job: 'review-lens', issueKey: 'DEV-1' },
    ])
  })
})
