const liveRunMemberSpec = {
  name: 'live-run-member-boundary',
  file: 'orchestrator/src/run/live-run-member.ts',
  allowed: [
    'bun:sqlite',
    '../../../shared/process-identity.ts',
    '../database/db.ts',
    '../events.ts',
    '../idle-kill.ts',
    '../process-resource-sampler.ts',
    '../jobs/jobs.ts',
    '../stalled-run.ts',
    './run-host-capacity.ts',
  ],
  typeOnlyAllowed: [],
  reason: 'Keep the canonical live member and its stall observation independent of adapters.',
} as const

export const runLivenessModuleSpecs = [
  {
    file: 'orchestrator/src/run/session-liveness.ts',
    allowed: ['../resources/session-process-anchoring.ts'],
    typeOnlyAllowed: [],
  },
  {
    file: 'orchestrator/src/run/session-liveness-adapter.ts',
    allowed: [
      'bun:sqlite',
      '../../../shared/process-identity.ts',
      '../database/db.ts',
      './session-liveness.ts',
    ],
    typeOnlyAllowed: [],
  },
  {
    file: 'orchestrator/src/run/run-answer-liveness.ts',
    allowed: [],
    typeOnlyAllowed: [],
  },
  liveRunMemberSpec,
] as const

export const runLivenessBoundarySpecs = [
  {
    name: 'session-liveness-boundary',
    file: 'orchestrator/src/run/session-liveness.ts',
    allowed: ['../resources/session-process-anchoring.ts'],
    typeOnlyAllowed: [],
    reason: 'Keep session liveness policy pure over stored ancestry and supplied probe facts.',
  },
  {
    name: 'session-liveness-adapter-boundary',
    file: 'orchestrator/src/run/session-liveness-adapter.ts',
    allowed: [
      'bun:sqlite',
      '../../../shared/process-identity.ts',
      '../database/db.ts',
      './session-liveness.ts',
    ],
    typeOnlyAllowed: [],
    reason: 'Keep process probing at the adapter around the pure session-liveness policy.',
  },
  liveRunMemberSpec,
] as const
