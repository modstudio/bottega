import { expect, test } from 'bun:test'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { renderEarlierRoundRejections } from '../dispatch/review-lens-prompt.ts'
import { reviewFindingMemoryRows } from './rejected-finding-memory.ts'
import { amendFinding, completeReview, recordReview, triageFinding } from './review-triage.ts'

function completedFinding(input: {
  project: string
  branch: string
  lens: string
  disposition: 'accepted' | 'rejected'
  commit: string
  location: string
}): number {
  const runId = addRun({
    agent: 'codex',
    job: 'review-lens',
    lens: input.lens,
    repo: input.project,
    headCommit: input.commit,
  })
  db().query('UPDATE run SET branch=? WHERE id=?').run(input.branch, runId)
  const reply = reviewReply(1, 'high')
  reply.findings[0]!.location = input.location
  reply.findings[0]!.evidence = `evidence at ${input.location}`
  const reviewId = recordReview(runId, reply, db())
  triageFinding(
    reviewId,
    1,
    input.disposition,
    input.disposition === 'rejected' ? 'incorrect' : undefined,
    undefined,
    db(),
  )
  completeReview(reviewId, db())
  return reviewId
}

test('reads and renders only the current same-project and same-branch rejection', () => {
  const matchingReview = completedFinding({
    project: 'bottega',
    branch: 'DEV-1373-target',
    lens: 'correctness',
    disposition: 'accepted',
    commit: 'matching-head-commit',
    location: 'orchestrator/src/matching.ts:12',
  })
  amendFinding(
    matchingReview,
    1,
    'rejected',
    'The contract permits the existing behavior.',
    'incorrect',
    undefined,
    db(),
  )
  db()
    .query('UPDATE review_lens SET reviewed_tree=? WHERE review_id=?')
    .run('tree-hash-that-is-not-the-commit', matchingReview)

  completedFinding({
    project: 'bottega',
    branch: 'DEV-1373-other',
    lens: 'correctness',
    disposition: 'rejected',
    commit: 'other-branch-commit',
    location: 'orchestrator/src/other-branch.ts:3',
  })
  completedFinding({
    project: 'starship',
    branch: 'DEV-1373-target',
    lens: 'correctness',
    disposition: 'rejected',
    commit: 'other-project-commit',
    location: 'app/other-project.ts:7',
  })
  const amendedAway = completedFinding({
    project: 'bottega',
    branch: 'DEV-1373-target',
    lens: 'safety',
    disposition: 'rejected',
    commit: 'amended-away-commit',
    location: 'orchestrator/src/amended-away.ts:9',
  })
  amendFinding(
    amendedAway,
    1,
    'accepted',
    'A second reading showed the finding was valid.',
    undefined,
    'high',
    db(),
  )

  const rendered = renderEarlierRoundRejections({
    project: 'bottega',
    branch: 'DEV-1373-target',
    rows: reviewFindingMemoryRows('bottega', db()),
  })

  expect(rendered).toContain('orchestrator/src/matching.ts:12')
  expect(rendered).toContain('reason: The contract permits the existing behavior.')
  expect(rendered).toContain('reviewed commit: matching-head-commit')
  expect(rendered).not.toContain('tree-hash-that-is-not-the-commit')
  expect(rendered).not.toContain('other-branch.ts')
  expect(rendered).not.toContain('other-project.ts')
  expect(rendered).not.toContain('amended-away.ts')
})
