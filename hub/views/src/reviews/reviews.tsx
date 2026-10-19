import { Badge } from '@bottega/hub-ui/badge'
import { FieldSection } from '@bottega/hub-ui/form-layout'
import type {
  RunDetailReviewFinding,
  RunDetailReviewLens,
} from '../../../../shared/review-presentation.ts'
import { reviewStyles } from './reviews.styles.ts'

export function ReviewLensList({ lenses }: { lenses: RunDetailReviewLens[] }) {
  if (!lenses.length) return <p className={reviewStyles().empty()}>No review lenses.</p>
  return (
    <div className={reviewStyles().list()}>
      {lenses.map((lens, index) => (
        <FieldSection
          key={lens.id}
          title={lens.lens || `Lens ${index + 1}`}
          description={lens.agent}
        >
          {lens.findings.length ? (
            lens.findings.map((finding: RunDetailReviewFinding) => (
              <div key={finding.id} className={reviewStyles().finding()}>
                <div className={reviewStyles().findingHead()}>
                  <Badge>{finding.severity}</Badge>
                  <span className={reviewStyles().muted()}>{finding.location}</span>
                </div>
                <p>{finding.evidence}</p>
                {finding.proposedCorrection ? (
                  <p className={reviewStyles().correction()}>{finding.proposedCorrection}</p>
                ) : null}
              </div>
            ))
          ) : (
            <p className={reviewStyles().muted()}>No findings.</p>
          )}
        </FieldSection>
      ))}
    </div>
  )
}
