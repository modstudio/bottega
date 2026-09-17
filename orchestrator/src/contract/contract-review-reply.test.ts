import { describe, expect, test } from 'bun:test'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { parseReviewReply } from '../review/review.ts'

describe('review discipline', () => {
  test('review parsing requires one of the three canon provenance values', () => {
    expect(parseReviewReply(reviewReply(0))?.provenance.canon_source).toBe('live database')
    const missing = reviewReply(0) as Omit<ReturnType<typeof reviewReply>, 'provenance'> & {
      provenance: Partial<ReturnType<typeof reviewReply>['provenance']>
    }
    delete missing.provenance.canon_source
    expect(parseReviewReply(missing)).toBeNull()
    expect(
      parseReviewReply({
        ...reviewReply(0),
        provenance: { ...reviewReply(0).provenance, canon_source: 'connected' },
      }),
    ).toBeNull()
    const missingSection = reviewReply(0) as Omit<ReturnType<typeof reviewReply>, 'provenance'> & {
      provenance: Partial<ReturnType<typeof reviewReply>['provenance']>
    }
    delete missingSection.provenance.substitutes
    expect(parseReviewReply(missingSection)?.provenance.substitutes).toEqual([])
  })
  test('review parsing accepts an omitted or legacy claimed tree', () => {
    const omitted = reviewReply(0)
    delete (omitted.provenance as Partial<typeof omitted.provenance>).tree_inspected
    expect(parseReviewReply(omitted)?.provenance.tree_inspected).toBeUndefined()
    expect(parseReviewReply(reviewReply(0))?.provenance.tree_inspected).toBe('abc123')
  })
})
