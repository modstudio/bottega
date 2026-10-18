// concern: caller-classification
import {
  classifyCaller,
  type CallerClassification,
  WORKER_ENVIRONMENT_MARKERS,
} from '../../shared/caller-classification.ts'

export { classifyCaller, type CallerClassification, WORKER_ENVIRONMENT_MARKERS }

export type CallerIdentityResolution =
  | { kind: 'identity'; session: string }
  | { kind: 'no-identity'; reason: 'worker' }
  | { kind: 'no-identity'; reason: 'unsupported-harness'; markers: string[] }
  | { kind: 'no-identity'; reason: 'reserved-operator-prefix' }
  | { kind: 'no-identity'; reason: 'operator-machine-id-missing' }

export function resolveCallerIdentity(
  caller: CallerClassification,
  operatorMachineId: string | null,
): CallerIdentityResolution {
  if (caller.kind === 'worker') return { kind: 'no-identity', reason: 'worker' }
  if (caller.kind === 'unsupported-harness')
    return { kind: 'no-identity', reason: 'unsupported-harness', markers: caller.markers }
  if (caller.kind === 'reserved-operator-session')
    return { kind: 'no-identity', reason: 'reserved-operator-prefix' }
  if (caller.kind === 'harness') return { kind: 'identity', session: caller.session }
  return operatorMachineId
    ? { kind: 'identity', session: `operator:${operatorMachineId}` }
    : { kind: 'no-identity', reason: 'operator-machine-id-missing' }
}

export function callerIdentityRefusal(
  resolution: CallerIdentityResolution,
  action: string,
): string {
  if (resolution.kind === 'identity') throw new Error('caller has an identity')
  if (resolution.reason === 'worker') return `this caller is a worker; a worker cannot ${action}`
  if (resolution.reason === 'unsupported-harness')
    return `this caller is an unsupported harness (${resolution.markers.join(', ')}); run the command from a terminal outside that harness`
  if (resolution.reason === 'reserved-operator-prefix')
    return 'this harness session uses the reserved operator: prefix; run the command from a terminal outside that harness'
  return 'this operator has no machine identity yet; run any orch command that opens the store for writing, then retry'
}
