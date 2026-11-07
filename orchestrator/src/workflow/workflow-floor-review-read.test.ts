import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  catalogueFloors,
  decideFloorSatisfaction,
  decideReviewReadArtifact,
} from './workflow-floor.ts'
import type { CursorIdentity } from './workflow-floor-evidence.ts'
import { gatherValidatedEvidence } from './workflow-floor-evidence-gather.ts'

const identity: CursorIdentity = {
  project: 'fixture',
  workflowKey: 'DEV-2053',
  branch: 'DEV-2053-work',
  worktree: '/fixture/work',
  session: 'session',
  createdAt: '2026-11-06',
  stepActivatedAt: '2026-11-06',
}

const database = testDatabaseFixture((d) => {
  d.query(
    `INSERT INTO project (record_id,name,path,stack,settings)
     VALUES (?,'fixture','/fixture','bun','{"trunk":"main"}')`,
  ).run(newRecordId())
})

test('a review read is refused with a worktree remedy when the cursor tip is unavailable', () => {
  expect(decideReviewReadArtifact({ reviewedCommit: 'read-commit', branchTip: null })).toEqual({
    accepted: false,
    message:
      'this cursor records no worktree, so its branch tip cannot be established; pass `--arg worktree=<tree>` on the cursor to clear this refusal',
  })
})

test('a missing review read is refused with the recording remedy', () => {
  const readRecordId = newRecordId()
  expect(() =>
    gatherValidatedEvidence({
      cursorId: newRecordId(),
      identity,
      stepOrdinal: 1,
      stepSlug: 'review-lenses',
      floors: catalogueFloors(['recorded-artifact']),
      evidence: { artifact: `review-read:${readRecordId}` },
      ports: { resolveTreeCommit: () => 'tip-commit' },
      d: database(),
    }),
  ).toThrow(
    `record a fresh read with \`${PLATFORM_SLUG} review read --cwd <tree> --sha <tip> --note <text>\` and pass its id as \`--artifact review-read:<UUID>\``,
  )
})

test.each([
  ['cursor tip', 'tip-commit', true],
  ['another commit', 'other-commit', false],
] as const)(
  'a review read of the %s is accepted only at the cursor tip',
  (_case, tip, accepted) => {
    const d = database()
    const readRecordId = newRecordId()
    d.query(
      `INSERT INTO review_read
      (record_id,project,project_record_id,branch,tip,patch_id,path_set,tier,note,recorded_at)
     VALUES (?,'fixture',(SELECT record_id FROM project WHERE name='fixture'),
             'DEV-2053-work',?,'patch','[]',0,'read the change','2026-11-06')`,
    ).run(readRecordId, tip)
    const readEvidence = () =>
      gatherValidatedEvidence({
        cursorId: newRecordId(),
        identity,
        stepOrdinal: 1,
        stepSlug: 'review-lenses',
        floors: catalogueFloors(['recorded-artifact']),
        evidence: { artifact: `review-read:${readRecordId}` },
        ports: { resolveTreeCommit: () => 'tip-commit' },
        d,
      })
    if (!accepted) {
      expect(readEvidence).toThrow(
        `review-read commit ${tip} is not this cursor's branch tip tip-commit; record a fresh read with \`${PLATFORM_SLUG} review read --cwd <tree> --sha <tip> --note <text>\` and pass its id as \`--artifact review-read:<UUID>\``,
      )
      return
    }
    expect(
      decideFloorSatisfaction({
        floors: catalogueFloors(['recorded-artifact']),
        evidence: readEvidence(),
        enforcement: 'floors',
        finishing: false,
        openObligations: [],
      }),
    ).toMatchObject({ action: 'allow' })
  },
)
