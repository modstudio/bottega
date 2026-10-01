const liveRunMemberSpec = {
  name: 'live-run-member-boundary',
  file: 'orchestrator/src/run/live-run-member.ts',
  allowed: [
    'bun:sqlite',
    '../../../shared/process-identity.ts',
    '../database/db.ts',
    '../events.ts',
    '../idle-kill.ts',
    '../jobs/jobs.ts',
    '../stalled-run.ts',
  ],
  typeOnlyAllowed: [],
  reason: 'Keep the canonical live member and its stall observation independent of adapters.',
} as const

export const runLivenessModuleSpecs = [
  {
    file: 'orchestrator/src/run/run-answer-liveness.ts',
    allowed: [],
    typeOnlyAllowed: [],
  },
  liveRunMemberSpec,
] as const

export const runLivenessBoundarySpecs = [liveRunMemberSpec] as const
