// concern: continuation provisioning decision
/** Decides what provisioning a continuation needs from recorded tree and seed facts. */

export type ContinuationSeedFacts = {
  seed: string | undefined
  refusal: string | null
}

export type ContinuationProvisioningDecision =
  | { action: 'none' }
  | { action: 'provision'; seed: string | undefined }
  | { action: 'refuse'; reason: 'missing-recorded-seed' }

export function continuationProvisioningDecision(input: {
  reuseIntactTree: boolean
  seed: ContinuationSeedFacts
}): ContinuationProvisioningDecision {
  if (input.reuseIntactTree) return { action: 'none' }
  if (input.seed.refusal) return { action: 'refuse', reason: 'missing-recorded-seed' }
  return { action: 'provision', seed: input.seed.seed }
}
