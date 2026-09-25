export const runResumeModuleSpecs = [
  {
    file: 'orchestrator/src/run/resume-tree.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/run-resume-kind.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/checkpoint-resume-context.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/continuation-checkpoint-context.ts',
    allowed: ['bun:sqlite', './checkpoint.ts', './resume-tree.ts'],
  },
] as const
