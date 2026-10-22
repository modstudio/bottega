import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  filedIssueClaimable,
  filedIssueStateForProject,
  unscoredFiledIssueLoopRuns,
} from './issue-dispatch.ts'

test('project-scoped filed issue state belongs wholly to the platform project', () => {
  const state = {
    waiting: [
      { key: 'DEV-1', title: 'waiting' },
      { key: 'DEV-2', title: 'also waiting' },
    ],
    unworked: [{ key: 'DEV-3', title: null }],
    blocked: {
      held: [{ runId: '1', path: '/tree', why: 'held' }],
      limit: 1,
    },
    unscored: [
      { runId: '3', job: 'diagnose', issueKey: 'DEV-1' },
      { runId: '4', job: 'diagnose', issueKey: 'DEV-2' },
    ],
  }
  expect(filedIssueStateForProject(state, PLATFORM_SLUG)).toEqual(state)
  expect(filedIssueStateForProject(state, 'other-project')).toEqual({
    waiting: [],
    unworked: [],
    blocked: null,
    unscored: [],
  })
  expect(filedIssueStateForProject(state, null)).toEqual({
    waiting: [],
    unworked: [],
    blocked: null,
    unscored: [],
  })
})

describe('filed-issue claiming', () => {
  test('explicit mode accepts open, active, and review while queue mode excludes review', () => {
    expect(filedIssueClaimable('open', false)).toBeTrue()
    expect(filedIssueClaimable('active', false)).toBeTrue()
    expect(filedIssueClaimable('review', false)).toBeTrue()
    expect(filedIssueClaimable('open', true)).toBeTrue()
    expect(filedIssueClaimable('active', true)).toBeTrue()
    expect(filedIssueClaimable('review', true)).toBeFalse()
    expect(filedIssueClaimable('closed', false)).toBeFalse()
  })
})

describe('unscored filed-issue loop runs', () => {
  test('lists terminal loop-started runs that have no verdict', () => {
    const diagnosis = addRun({ agent: 'codex', job: 'diagnose' })
    const fix = addRun({ agent: 'codex', job: 'issue-worker' })
    const lens = addRun({ agent: 'codex', job: 'review-lens' })
    const hand = addRun({ agent: 'codex', job: 'diagnose' })
    const sessionOwned = addRun({ agent: 'codex', job: 'diagnose', session: 'session' })
    const judged = addRun({ agent: 'codex', job: 'diagnose' })
    const failed = addRun({ agent: 'codex', job: 'diagnose', status: 'failed' })
    db().query('UPDATE run SET label=? WHERE record_id=?').run('issue DEV-1 diagnosis', diagnosis)
    db().query('UPDATE run SET label=? WHERE record_id=?').run('issue DEV-1 fix', fix)
    db()
      .query('UPDATE run SET label=? WHERE record_id=?')
      .run('issue DEV-1 review correctness', lens)
    db().query('UPDATE run SET label=? WHERE record_id=?').run('hand-dispatched diagnosis', hand)
    db()
      .query('UPDATE run SET label=? WHERE record_id=?')
      .run('issue DEV-1 diagnosis', sessionOwned)
    db().query('UPDATE run SET label=? WHERE record_id=?').run('issue DEV-1 diagnosis', judged)
    db().query('UPDATE run SET label=? WHERE record_id=?').run('issue DEV-1 diagnosis', failed)
    score(judged, 'full', 'right')
    expect(unscoredFiledIssueLoopRuns()).toEqual([
      { runId: diagnosis, job: 'diagnose', issueKey: 'DEV-1' },
      { runId: fix, job: 'issue-worker', issueKey: 'DEV-1' },
      { runId: lens, job: 'review-lens', issueKey: 'DEV-1' },
    ])
  })
})
