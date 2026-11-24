// concern: architecture-manifest
/** Import boundaries for session start, kept with the session concern rather than cleanup. */

export const sessionStartBoundarySpecs = [
  {
    name: 'harness-session-decision-boundary',
    file: 'orchestrator/src/harness-session/harness-session-decision.ts',
    allowed: [],
    typeOnlyAllowed: ['../../../shared/harness-name.ts', '../../../shared/process-identity.ts'],
    reason: 'Keep harness publication measurement pure over process identities.',
  },
  {
    name: 'harness-session-boundary',
    file: 'orchestrator/src/harness-session/harness-session.ts',
    allowed: [
      'node:crypto',
      'node:fs',
      'node:path',
      '../../../shared/harness-name.ts',
      '../../../shared/process-identity.ts',
      '../../../shared/state-directory.ts',
      '../resources/process-inventory.ts',
      './harness-session-decision.ts',
    ],
    typeOnlyAllowed: [],
    reason: 'Keep machine-local harness publication storage behind one adapter.',
  },
  {
    name: 'session-start-decision-boundary',
    file: 'orchestrator/src/session/session-start-decision.ts',
    allowed: [],
    typeOnlyAllowed: [],
    reason: 'Keep the session explore idempotence decision pure over observed cursor facts.',
  },
  {
    name: 'session-start-boundary',
    file: 'orchestrator/src/session/session-start.ts',
    allowed: [
      'bun:sqlite',
      'node:path',
      '../../../shared/brand.ts',
      '../../../shared/refusal.ts',
      '../caller-classification.ts',
      '../database/db.ts',
      '../harness-session/harness-session.ts',
      '../project/projects.ts',
      '../workflow/task-flow-store.ts',
      '../workflow/workflow-cursor-live-autonomy.ts',
      '../workflow/workflow-cursor.ts',
      './session-start-decision.ts',
    ],
    typeOnlyAllowed: ['bun:sqlite'],
    reason:
      'Keep session-start composition in one adapter over project, cursor, and autonomy owners.',
  },
] as const
