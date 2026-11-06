// concern: architecture-manifest
/** Small root-level orchestrator modules with narrow import surfaces. */

export const coreModuleSpecs = [
  {
    file: 'orchestrator/src/caller-classification.ts',
    allowed: ['../../shared/caller-classification.ts'],
  },
  {
    file: 'orchestrator/src/artifact-paths.ts',
    allowed: ['node:path', './run-owned-paths.ts'],
  },
  { file: 'orchestrator/src/run-owned-paths.ts', allowed: ['node:path'] },
  {
    file: 'orchestrator/src/process-resource-sampler.ts',
    allowed: ['../../shared/process-identity.ts'],
  },
  { file: 'orchestrator/src/local-listener.ts', allowed: [] },
  { file: 'orchestrator/src/refusal-error.ts', allowed: [] },
  {
    file: 'orchestrator/src/secret-shaped-output.ts',
    allowed: ['../../shared/secret-shaped.ts'],
  },
  { file: 'orchestrator/src/tool-event-text.ts', allowed: [] },
  {
    file: 'orchestrator/src/transport/transport-goose-ledger.ts',
    allowed: [
      'node:fs',
      'node:path',
      '../run-owned-paths.ts',
      './transport-goose-context-profile.ts',
    ],
  },
  {
    file: 'orchestrator/src/transport/transport-goose-context-profile.ts',
    allowed: ['bun:sqlite', 'node:fs', 'node:path', '../run/run-context-profile.ts'],
  },
  { file: 'orchestrator/src/worker-store-write.ts', allowed: [] },
  {
    file: 'orchestrator/src/git/evidence-checkout.ts',
    allowed: [
      '../../../shared/brand.ts',
      '../../../shared/git.ts',
      '../project/projects.ts',
      './checkout-identity.ts',
    ],
  },
] as const
