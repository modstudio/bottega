import { describe, expect, test } from 'bun:test'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../db.ts'
import { guide } from '../guide.ts'
import { recordReview } from '../review-triage.ts'
import { evidenceFor, MIN_SAMPLE, pick } from './route.ts'

describe('findings routing narrows to a lens only when that buys a comparison', () => {
  const judgedLensRun = (
    agent: string,
    lens: string,
    quality: 'wrong' | 'mixed' | 'right',
    recorded = true,
  ) => {
    const runId = addRun({ agent, job: 'review-lens', lens })
    if (recorded) recordReview(runId, reviewReply(0), db())
    score(runId, 'full', quality)
    return runId
  }
  test('two proven lens cells can route the same job to different agents', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      judgedLensRun('codex', 'correctness', 'right')
      judgedLensRun('grok', 'correctness', 'wrong')
      judgedLensRun('codex', 'migration-safety', 'wrong')
      judgedLensRun('grok', 'migration-safety', 'right')
    }
    const correctness = pick('review-lens', undefined, 0, false, null, {}, false, 'correctness')
    const migration = pick('review-lens', undefined, 0, false, null, {}, false, 'migration-safety')
    expect(correctness.agent).toBe('codex')
    expect(correctness.reason).toContain('lens correctness cell')
    expect(migration.agent).toBe('grok')
    expect(migration.reason).toContain('lens migration-safety cell')
  })
  test('one proven agent on a lens backs off to the job-wide cell', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      judgedLensRun('codex', 'correctness', 'wrong')
      judgedLensRun('grok', 'unrecorded', 'right', false)
    }
    const ev = evidenceFor('review-lens', 0, null, undefined, 'correctness')
    expect(ev.level).toBe('job')
    expect(ev.scoped!.find((candidate) => candidate.agent === 'codex')!.evidence).toBe(MIN_SAMPLE)
    const routed = pick('review-lens', undefined, 0, false, null, {}, false, 'correctness')
    expect(routed.agent).toBe('grok')
    expect(routed.reason).toContain('job-wide cell')
  })
  test('a scored run without a recorded review lens contributes only job-wide', () => {
    judgedLensRun('codex', 'correctness', 'right', false)
    const ev = evidenceFor('review-lens', 0, null, undefined, 'correctness')
    expect(ev.job.find((candidate) => candidate.agent === 'codex')!.evidence).toBe(1)
    expect(ev.scoped!.find((candidate) => candidate.agent === 'codex')!.evidence).toBe(0)
  })
  test('guide names the deciding cell and reports lens and job-wide counts', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      judgedLensRun('codex', 'correctness', 'right')
      judgedLensRun('grok', 'correctness', 'mixed')
    }
    const row = guide('review-lens', 0, 'correctness')[0]!
    expect(row.reason).toContain('lens correctness cell')
    expect(row.evidenceCells).toEqual([
      {
        name: 'lens correctness',
        counts: expect.arrayContaining([
          { agent: 'codex', evidence: MIN_SAMPLE },
          { agent: 'grok', evidence: MIN_SAMPLE },
        ]),
      },
      {
        name: 'job-wide',
        counts: expect.arrayContaining([
          { agent: 'codex', evidence: MIN_SAMPLE },
          { agent: 'grok', evidence: MIN_SAMPLE },
        ]),
      },
    ])
  })
})
