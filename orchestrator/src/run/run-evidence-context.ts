// concern: run evidence classification
/** Classifies the evidence expected from one run prompt. */
import { assessEvidencePrompt } from '../evidence/evidence.ts'
import { isReaderJob } from '../jobs/jobs.ts'

export function runEvidence(jobName: string, findingsJob: boolean, declaredDeliverables: string[]) {
  return assessEvidencePrompt({
    findingsJob,
    verifyClaimJob: jobName === 'verify-claim',
    readerJob: isReaderJob(jobName),
    declaredDeliverables,
  })
}
