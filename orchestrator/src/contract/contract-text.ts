// concern: contract

import { job, jobBoundInstructionForContract } from '../jobs.ts'
import {
  NO_REPO_PREAMBLE,
  READONLY_PREAMBLE,
  REVIEW_SEVERITY_INSTRUCTION,
  WORKER_PREAMBLE,
} from './contract.ts'

/** The exact contract presented for a named job. */
export function contractText(jobName: string): string {
  const selected = job(jobName)
  const preamble = selected.needs.writesRepo
    ? WORKER_PREAMBLE
    : selected.needs.readsRepo
      ? READONLY_PREAMBLE
      : NO_REPO_PREAMBLE
  return (
    (selected.findings ? `${REVIEW_SEVERITY_INSTRUCTION}\n\n` : '') +
    preamble +
    '\n\n' +
    jobBoundInstructionForContract(selected) +
    '\n'
  )
}
