// concern: architecture-manifest
/** Small root-level orchestrator modules with narrow import surfaces. */

export const coreModuleSpecs = [
  { file: 'orchestrator/src/caller-classification.ts', allowed: [] },
  { file: 'orchestrator/src/artifact-paths.ts', allowed: ['node:path'] },
  { file: 'orchestrator/src/refusal-error.ts', allowed: [] },
  { file: 'orchestrator/src/worker-store-write.ts', allowed: [] },
] as const
