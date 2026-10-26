// concern: harness delegation route
/** Resolves the machine's harness marker before external-agent routing. */

import { readDelegationSettings } from '../../../shared/machine-config.ts'
import { harnessDelegationRefusal, isHarnessDelegated } from '../jobs/delegation.ts'
import { job } from '../jobs/jobs.ts'
import { RoutingRefusalError } from './routing-refusal.ts'

export function harnessSelection(jobName: string, allowed: boolean) {
  return allowed && isHarnessDelegated(job(jobName).needs, readDelegationSettings())
    ? { agent: 'harness', reason: 'machine delegation mode' }
    : null
}

export function assertExternalDelegation(jobName: string): void {
  const refusal = harnessDelegationRefusal(job(jobName), readDelegationSettings())
  if (refusal) throw new RoutingRefusalError(refusal)
}
