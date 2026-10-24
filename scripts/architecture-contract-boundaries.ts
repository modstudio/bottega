// concern: architecture-manifest
/** The contract concern's import boundary, kept beside the root manifest so it stays within its file ceiling. */
export type ContractBoundarySpec = {
  name: string
  file: string
  allowed: string[]
  typeOnlyAllowed: string[]
  reason: string
}

export const contractBoundarySpecs: ContractBoundarySpec[] = [
  {
    name: 'contract-boundary',
    file: 'orchestrator/src/contract/contract.ts',
    allowed: [
      '../../../shared/brand.ts',
      '../jobs/jobs.ts',
      '../outcome.ts',
      '../review/review-vocabulary.ts',
      '../run/checkpoint.ts',
      './contract-reply.ts',
    ],
    typeOnlyAllowed: [],
    reason: 'Keep reply dialect resolution independent of lifecycle and impure transport concerns.',
  },
]
