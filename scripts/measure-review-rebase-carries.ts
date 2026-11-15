// concern: review-rebase-carry-measurement
/** Compares legacy and current same-change decisions over recorded rebase carries. */

import { Database } from 'bun:sqlite'
import { git, measureChangeIdentity, reviewGit } from '../orchestrator/src/review/review-pins.ts'
import { gatherSameChange } from '../orchestrator/src/review/same-change-git.ts'

type CarryRow = {
  record_id: string
  path: string
  tip: string
  reviewed_commit: string
  old_base: string
  new_base: string
  review_patch_id: string | null
  review_zero_context_patch_id: string | null
  review_path_set: string | null
  review_message: string | null
}

const store = process.env.BOTTEGA_ORCHESTRATOR_DB?.trim()
if (!store) throw new Error('BOTTEGA_ORCHESTRATOR_DB must name the store to measure')
const database = new Database(store, { readonly: true, strict: true })
const hasZeroContext = Boolean(
  database
    .query<{ found: number }, []>(
      "SELECT 1 AS found FROM pragma_table_info('review') WHERE name='zero_context_patch_id'",
    )
    .get(),
)
const rows = database
  .query<CarryRow, []>(
    `SELECT carry.record_id,project.path,carry.tip,carry.reviewed_commit,carry.old_base,carry.new_base,
            review.patch_id AS review_patch_id,
            ${hasZeroContext ? 'review.zero_context_patch_id' : 'NULL'} AS review_zero_context_patch_id,
            review.path_set AS review_path_set,review.commit_message AS review_message
       FROM landing_review_carry carry
       JOIN project ON project.record_id=carry.project_record_id
       JOIN review ON review.record_id=carry.review_record_id
      ORDER BY carry.at,carry.record_id`,
  )
  .all()

let evaluated = 0
let legacyReOwedCurrentCarries = 0
let legacyCarriedCurrentReOwes = 0
const unavailable: { recordId: string; reason: string }[] = []
for (const row of rows) {
  const current = measureChangeIdentity(row.path, row.new_base, row.tip)
  const tree = git(row.path, ['rev-parse', `${row.tip}^{tree}`])
  if (!current || !tree.ok) {
    unavailable.push({ recordId: row.record_id, reason: 'current range is unreachable' })
    continue
  }
  const reviewedPaths = row.review_path_set ? (JSON.parse(row.review_path_set) as string[]) : []
  const legacySame =
    row.review_patch_id === current.patchId &&
    JSON.stringify([...reviewedPaths].sort()) === JSON.stringify([...current.paths].sort())
  const decision = gatherSameChange({
    runner: reviewGit(row.path),
    reviewed: {
      patchId: row.review_patch_id,
      zeroContextPatchId: row.review_zero_context_patch_id,
      paths: reviewedPaths,
      message: row.review_message,
    },
    reviewedCommit: row.reviewed_commit,
    oldBase: row.old_base,
    current: { paths: current.paths, message: current.message },
    tip: row.tip,
    tipTree: tree.out,
    newBase: row.new_base,
  })
  evaluated += 1
  if (!legacySame && decision.same) legacyReOwedCurrentCarries += 1
  if (legacySame && !decision.same) legacyCarriedCurrentReOwes += 1
  if (!decision.same && decision.reason?.includes('missing')) {
    unavailable.push({ recordId: row.record_id, reason: decision.reason })
  }
}

console.log(
  JSON.stringify(
    {
      recordedCarries: rows.length,
      evaluated,
      legacyReOwedCurrentCarries,
      legacyCarriedCurrentReOwes,
      unavailable,
    },
    null,
    2,
  ),
)
database.close()
